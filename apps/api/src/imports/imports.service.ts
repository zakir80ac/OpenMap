// REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — importing a spreadsheet or another CMDB's export. The file is read (CSV by the
// contract's RFC 4180 reader, XLSX by ExcelJS, first worksheet), mapped with the contract's mapping (proposed from the
// headers when none is given, a ServiceNow export recognised) and turned into observations; a preview writes nothing,
// a run records the job and queues the observations for the reconciler as collector results from the `import` source
// in chunks, all carrying the job's run id. The reconciler reads them at RECONCILIATION.importSeedConfidence, so an
// import fills what discovery has not observed and never overwrites it.
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { CONTRACT_VERSIONS, IMPORTS } from '@openmap/constants';
import {
  importMappingSchema,
  parseCsv,
  readImport,
  suggestMapping,
  type CollectorResult,
  type ImportFormat,
  type ImportMapping,
  type ImportReading,
  type RejectedRow,
} from '@openmap/contracts';
import type { Prisma } from '@openmap/db';
import { createResultsQueue, type ResultsQueue } from '@openmap/scheduler/results-queue';
import ExcelJS from 'exceljs';
import { withSpan } from '@openmap/telemetry';
import { isoOf } from '../common/time.js';
import { ENV, type Env } from '../config/env.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface ImportInputView {
  filename: string;
  format: ImportFormat;
  contentBase64: string;
  mapping: unknown;
}

export interface ImportPreviewView {
  headers: string[];
  mapping: ImportMapping;
  rows: number;
  accepted: number;
  rejected: number;
  rejectedRows: RejectedRow[];
  byType: ImportReading['byType'];
  sample: string[][];
}

export interface ImportJobView {
  id: string;
  filename: string;
  format: ImportFormat;
  rows: number;
  accepted: number;
  rejected: number;
  rejectedRows: RejectedRow[];
  byType: ImportReading['byType'];
  runId: string;
  created: number;
  submittedBy: string;
  createdAt: string;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 'YYYY-MM-DD'.length);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value && value.result !== undefined && value.result !== null) return String(value.result as string | number | boolean);
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    return '';
  }
  return String(value);
}

/** Rows of an XLSX workbook's first worksheet as text, the header first. */
export async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) return [];
  const rows: string[][] = [];
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c).value).trim());
    if (cells.some((v) => v !== '')) rows.push(cells);
  });
  return rows;
}

@Injectable()
export class ImportsService implements OnModuleDestroy {
  private queue: ResultsQueue | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.queue !== null) await this.queue.close();
  }

  private results(): ResultsQueue {
    this.queue ??= createResultsQueue(this.env);
    return this.queue;
  }

  private async rowsOf(input: ImportInputView): Promise<string[][]> {
    const buffer = Buffer.from(input.contentBase64, 'base64');
    if (buffer.length === 0) throw new BadRequestException('the file is empty');
    if (buffer.length > IMPORTS.maxFileBytes) throw new BadRequestException('the file is larger than ' + String(IMPORTS.maxFileBytes) + ' bytes');
    const rows = input.format === 'csv' ? parseCsv(buffer.toString('utf8')) : await readXlsx(buffer);
    if (rows.length === 0) throw new BadRequestException('the file has no rows');
    return rows;
  }

  private mappingOf(input: ImportInputView, headers: readonly string[]): ImportMapping {
    if (input.mapping === null || input.mapping === undefined) return suggestMapping(headers);
    const parsed = importMappingSchema.safeParse(input.mapping);
    if (!parsed.success) throw new BadRequestException('invalid mapping: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
    return parsed.data;
  }

  async preview(input: ImportInputView): Promise<ImportPreviewView> {
    return withSpan(TRACER_NAME, 'import.preview', { 'openmap.import.format': input.format }, async () => {
      const rows = await this.rowsOf(input);
      const headers = rows[0] ?? [];
      const mapping = this.mappingOf(input, headers);
      const reading = readImport(rows, mapping, new Date().toISOString());
      return {
        headers,
        mapping,
        rows: rows.length - 1,
        accepted: reading.observations.length,
        rejected: reading.rejected.length,
        rejectedRows: reading.rejected.slice(0, IMPORTS.maxRejectedShown),
        byType: reading.byType,
        sample: rows.slice(1, 1 + IMPORTS.previewRows),
      };
    });
  }

  async run(tenantId: string, actor: string, input: ImportInputView): Promise<ImportJobView> {
    return withSpan(TRACER_NAME, 'import.run', { 'openmap.import.format': input.format }, async () => {
      const rows = await this.rowsOf(input);
      const mapping = this.mappingOf(input, rows[0] ?? []);
      const observedAt = new Date().toISOString();
      const reading = readImport(rows, mapping, observedAt);
      if (reading.observations.length === 0) throw new BadRequestException('no row of the file can be imported');
      const runId = randomUUID();
      const job = await this.prisma.client.importJob.create({
        data: {
          tenantId,
          filename: input.filename,
          format: input.format,
          rows: rows.length - 1,
          accepted: reading.observations.length,
          rejected: reading.rejected.length,
          rejectedRows: reading.rejected.slice(0, IMPORTS.maxRejectedShown) as unknown as Prisma.InputJsonValue,
          mapping: mapping as unknown as Prisma.InputJsonValue,
          byType: reading.byType as Prisma.InputJsonValue,
          runId,
          submittedBy: actor,
        },
      });
      for (let i = 0; i < reading.observations.length; i += IMPORTS.resultChunk) {
        const cis = reading.observations.slice(i, i + IMPORTS.resultChunk);
        const result: CollectorResult = {
          jobId: randomUUID(),
          runId,
          tenantId,
          collectorId: IMPORTS.collectorId,
          nodeId: IMPORTS.nodeId,
          status: 'success',
          startedAt: observedAt,
          finishedAt: new Date().toISOString(),
          cis,
          relationships: [],
          samples: [],
          evidence: [],
          errors: [],
          metrics: { targetsAttempted: cis.length, targetsReached: cis.length, cisEmitted: cis.length, relationshipsEmitted: 0, durationMs: 0 },
          contractVersion: CONTRACT_VERSIONS.collector,
        };
        // Every chunk keeps the import's run id (the CIs it creates carry it as provenance) under its own queue job id.
        await this.results().publish(result, result.jobId);
      }
      this.metrics.importRows.inc({ outcome: 'queued' }, reading.observations.length);
      this.metrics.importRows.inc({ outcome: 'rejected' }, reading.rejected.length);
      return this.view(job, 0);
    });
  }

  async jobs(tenantId: string): Promise<ImportJobView[]> {
    const jobs = await this.prisma.client.importJob.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: IMPORTS.previewRows });
    const created = jobs.length === 0 ? [] : await this.prisma.client.ci.groupBy({ by: ['sourceRunId'], where: { tenantId, validTo: null, sourceCollectorId: IMPORTS.collectorId, sourceRunId: { in: jobs.map((j) => j.runId) } }, _count: { _all: true } });
    const byRun = new Map(created.map((c) => [c.sourceRunId, c._count._all]));
    return jobs.map((j) => this.view(j, byRun.get(j.runId) ?? 0));
  }

  private view(job: Awaited<ReturnType<PrismaService['client']['importJob']['create']>>, created: number): ImportJobView {
    const byType = job.byType as ImportReading['byType'];
    return {
      id: job.id,
      filename: job.filename,
      format: job.format as ImportFormat,
      rows: job.rows,
      accepted: job.accepted,
      rejected: job.rejected,
      rejectedRows: job.rejectedRows as unknown as RejectedRow[],
      byType,
      runId: job.runId,
      created,
      submittedBy: job.submittedBy,
      createdAt: isoOf(job.createdAt),
    };
  }
}
