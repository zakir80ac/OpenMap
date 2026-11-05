// REQ-CMDB-033 (ADR-032) — GET /export/cis?format=csv|xlsx|json plus the CMDB filter (types, layers, lifecycle,
// tags, text): every current CI the filter selects, streamed page by page (IMPORTS.exportPageSize) so a 100k-CI
// estate never sits in memory, as CSV (RFC 4180), an XLSX workbook (ExcelJS streaming writer) or a JSON array.
// Authenticated like every route; analysts and above.
import { PassThrough } from 'node:stream';
import { BadRequestException, Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { IMPORTS } from '@openmap/constants';
import { CI_TYPES, csvField } from '@openmap/contracts';
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import { ciFilterSchema, type CiFilterInput } from '../ci/ci.schemas.js';
import type { CiRecord } from '../ci/ci.types.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { EXPORT_FORMATS, exportHeaders, exportObject, exportRow, identityColumns, type ExportFormat } from './export.js';

const list = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v.split(',').map((x) => x.trim()).filter((x) => x !== '')));
const queryArgs = z.object({
  format: z.enum(EXPORT_FORMATS).default('csv'),
  types: list,
  layers: list,
  lifecycle: list,
  tags: list,
  text: z.string().optional(),
});

/** The byte-order mark a CSV starts with, so Excel reads it as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
};

@Controller('export')
export class ExportController {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly metrics: MetricsService,
  ) {}

  @Get('cis')
  @Roles(ROLES.analyst)
  async cisExport(@Query() raw: Record<string, string | undefined>, @Req() request: AuthenticatedRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = queryArgs.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('export arguments: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
    const args = parsed.data;
    const filterParsed = ciFilterSchema.safeParse({ types: args.types, layers: args.layers, lifecycle: args.lifecycle, tags: args.tags, text: args.text });
    if (!filterParsed.success) throw new BadRequestException('export filter: ' + filterParsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
    const filter = filterParsed.data;
    const tenantId = request.principal?.tenantId ?? '';
    const identityKeys = identityColumns(filter.types ?? CI_TYPES);
    const stamp = new Date().toISOString().slice(0, 'YYYY-MM-DDTHH-MM'.length).replaceAll(':', '-');
    const out = new PassThrough();
    void reply
      .header('content-type', CONTENT_TYPE[args.format])
      .header('content-disposition', 'attachment; filename="openmap-cis-' + stamp + '.' + args.format + '"')
      .send(out);
    let rows = 0;
    try {
      if (args.format === 'xlsx') {
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
        const sheet = workbook.addWorksheet('CIs');
        sheet.addRow(exportHeaders(identityKeys)).commit();
        rows = await this.pages(tenantId, filter, (ci) => {
          sheet.addRow(exportRow(ci, identityKeys)).commit();
        });
        sheet.commit();
        await workbook.commit();
      } else if (args.format === 'json') {
        out.write('[');
        let first = true;
        rows = await this.pages(tenantId, filter, (ci) => {
          out.write((first ? '' : ',') + JSON.stringify(exportObject(ci)));
          first = false;
        });
        out.end(']');
      } else {
        out.write(BOM + exportHeaders(identityKeys).map((h) => csvField(h)).join(',') + '\r\n');
        rows = await this.pages(tenantId, filter, (ci) => {
          out.write(exportRow(ci, identityKeys).map((v) => csvField(v)).join(',') + '\r\n');
        });
        out.end();
      }
      this.metrics.exportRows.inc({ format: args.format }, rows);
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Every CI the filter selects, in (name, id) order, a page at a time. */
  private async pages(tenantId: string, filter: CiFilterInput, write: (ci: CiRecord) => void): Promise<number> {
    let after: { name: string; id: string } | null = null;
    let count = 0;
    for (;;) {
      const page = await this.cis.list(tenantId, filter, null, IMPORTS.exportPageSize, after);
      for (const ci of page.items) write(ci);
      count += page.items.length;
      const last = page.items.at(-1);
      if (!page.hasNextPage || last === undefined) return count;
      after = { name: last.name, id: last.id };
    }
  }
}
