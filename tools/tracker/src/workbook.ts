// REQ-CORE-007 — read and write tracker/OpenMap-Tracker.xlsx with ExcelJS. The workbook is the
// system of record; this module is the only code that touches it.
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { REQ_STATUSES, TRACKER_SHEETS, WORKSTREAMS, WORKSTREAM_NAMES, PRIORITIES } from '@openmap/constants';
import {
  REQUIREMENT_COLUMNS,
  componentSchema,
  contractRowSchema,
  decisionSchema,
  requirementSchema,
  riskSchema,
  sessionSchema,
  testRowSchema,
  type Requirement,
  type TrackerData,
} from './model.js';

const LIST_SEPARATOR = ', ';

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E1322' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFEEF2FF' } };
const STATUS_FILL: Record<(typeof REQ_STATUSES)[number], string> = {
  'Not started': 'FFF1EFE8',
  'In progress': 'FFE6F1FB',
  Blocked: 'FFFCEBEB',
  'In review': 'FFFAEEDA',
  Done: 'FFEAF3DE',
};

function splitList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,;]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function rowsOf(sheet: ExcelJS.Worksheet | undefined): string[][] {
  if (!sheet) return [];
  const out: string[][] = [];
  sheet.eachRow((row, idx) => {
    if (idx === 1) return;
    const values: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) values.push(cellText(row.getCell(c)));
    if (values.some((v) => v !== '')) out.push(values);
  });
  return out;
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

export async function readWorkbook(path: string): Promise<TrackerData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const req = rowsOf(wb.getWorksheet(TRACKER_SHEETS.requirements)).map((r) =>
    requirementSchema.parse({
      id: r[0],
      workstream: r[1],
      capabilityArea: r[2],
      title: r[3],
      description: r[4] ?? '',
      acceptanceCriteria: r[5],
      priority: r[6],
      status: r[7],
      owner: r[8] ?? '',
      dependsOn: splitList(r[9]),
      specSection: r[10] ?? '',
      testIds: splitList(r[11]),
      evidence: r[12] ?? '',
      created: r[13] ?? '',
      updated: r[14] ?? '',
      notes: r[15] ?? '',
    }),
  );
  const components = rowsOf(wb.getWorksheet(TRACKER_SHEETS.components)).map((r) =>
    componentSchema.parse({ name: r[0], layer: r[1], versionPinned: r[2], licence: r[3], runsAs: r[4], airGapReady: r[5], replacedByOption: r[6] ?? '' }),
  );
  const contracts = rowsOf(wb.getWorksheet(TRACKER_SHEETS.contracts)).map((r) =>
    contractRowSchema.parse({ name: r[0], file: r[1], version: r[2], frozenOn: r[3] ?? '', lastAdr: r[4] ?? '' }),
  );
  const decisions = rowsOf(wb.getWorksheet(TRACKER_SHEETS.decisions)).map((r) =>
    decisionSchema.parse({ adr: r[0], title: r[1], status: r[2], date: r[3] ?? '', link: r[4] ?? '' }),
  );
  const risks = rowsOf(wb.getWorksheet(TRACKER_SHEETS.risks)).map((r) =>
    riskSchema.parse({ id: r[0], risk: r[1], likelihood: r[2], impact: r[3], mitigation: r[4] ?? '', owner: r[5] ?? '', status: r[6] }),
  );
  const tests = rowsOf(wb.getWorksheet(TRACKER_SHEETS.tests)).map((r) =>
    testRowSchema.parse({ id: r[0], type: r[1], covers: splitList(r[2]), lastRun: r[3] ?? '', result: r[4], durationMs: Number(r[5] ?? 0) }),
  );
  const sessions = rowsOf(wb.getWorksheet(TRACKER_SHEETS.sessions)).map((r) =>
    sessionSchema.parse({ date: r[0], summary: r[1], reqsTouched: splitList(r[2]), commits: splitList(r[3]), blockers: r[4] ?? '' }),
  );
  return { requirements: req, components, contracts, decisions, risks, tests, sessions };
}

function addSheet(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width: number }>, rows: Array<Record<string, unknown>>): ExcelJS.Worksheet {
  const sheet = wb.addWorksheet(name);
  sheet.columns = columns;
  for (const row of rows) sheet.addRow(row);
  styleHeader(sheet);
  return sheet;
}

function workstreamRows(requirements: Requirement[]): Array<Record<string, unknown>> {
  return WORKSTREAMS.map((ws) => {
    const rows = requirements.filter((r) => r.workstream === ws);
    const done = rows.filter((r) => r.status === 'Done').length;
    return {
      id: ws,
      name: WORKSTREAM_NAMES[ws],
      scope: [...new Set(rows.map((r) => r.capabilityArea))].join(LIST_SEPARATOR),
      lead: '',
      count: rows.length,
      done,
      pct: rows.length === 0 ? 0 : Math.round((done / rows.length) * 100),
    };
  });
}

function dashboardRows(data: TrackerData): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  rows.push(['Generated', new Date().toISOString()]);
  rows.push([]);
  rows.push(['Totals by status', ...REQ_STATUSES]);
  rows.push(['All', ...REQ_STATUSES.map((s) => data.requirements.filter((r) => r.status === s).length)]);
  rows.push([]);
  rows.push(['Workstream', ...REQ_STATUSES, 'Total', '% done']);
  for (const ws of WORKSTREAMS) {
    const rs = data.requirements.filter((r) => r.workstream === ws);
    const done = rs.filter((r) => r.status === 'Done').length;
    rows.push([ws, ...REQ_STATUSES.map((s) => rs.filter((r) => r.status === s).length), rs.length, rs.length ? Math.round((done / rs.length) * 100) : 0]);
  }
  rows.push([]);
  rows.push(['Priority', ...REQ_STATUSES, 'Total']);
  for (const p of PRIORITIES) {
    const rs = data.requirements.filter((r) => r.priority === p);
    rows.push([p, ...REQ_STATUSES.map((s) => rs.filter((r) => r.status === s).length), rs.length]);
  }
  rows.push([]);
  rows.push(['Burn-down by date', 'Done cumulative']);
  const doneDates = data.requirements.filter((r) => r.status === 'Done').map((r) => r.updated).sort();
  let cumulative = 0;
  for (const d of [...new Set(doneDates)]) {
    cumulative += doneDates.filter((x) => x === d).length;
    rows.push([d, cumulative]);
  }
  rows.push([]);
  rows.push(['Open blockers']);
  for (const r of data.requirements.filter((r) => r.status === 'Blocked')) rows.push([r.id, r.title, r.notes]);
  rows.push([]);
  rows.push(['Perf budget rows', 'Status']);
  for (const r of data.requirements.filter((r) => r.workstream === 'PERF')) rows.push([r.id + ' ' + r.title, r.status]);
  return rows;
}

export async function writeWorkbook(path: string, data: TrackerData): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpenMap tracker';
  wb.created = new Date();

  const reqSheet = addSheet(
    wb,
    TRACKER_SHEETS.requirements,
    REQUIREMENT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })),
    data.requirements.map((r) => ({ ...r, dependsOn: r.dependsOn.join(LIST_SEPARATOR), testIds: r.testIds.join(LIST_SEPARATOR) })),
  );
  const statusCol = REQUIREMENT_COLUMNS.findIndex((c) => c.key === 'status') + 1;
  reqSheet.eachRow((row, idx) => {
    if (idx === 1) return;
    const status = String(row.getCell(statusCol).value) as (typeof REQ_STATUSES)[number];
    const fill = STATUS_FILL[status];
    if (fill) row.getCell(statusCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    row.alignment = { vertical: 'top', wrapText: true };
  });
  reqSheet.getColumn(statusCol).eachCell((cell, idx) => {
    if (idx === 1) return;
    cell.dataValidation = { type: 'list', allowBlank: false, formulae: ['"' + REQ_STATUSES.join(',') + '"'] };
  });

  addSheet(
    wb,
    TRACKER_SHEETS.workstreams,
    [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Name', key: 'name', width: 44 },
      { header: 'Scope', key: 'scope', width: 80 },
      { header: 'Lead', key: 'lead', width: 14 },
      { header: 'Requirement count', key: 'count', width: 18 },
      { header: 'Done count', key: 'done', width: 12 },
      { header: '% complete', key: 'pct', width: 12 },
    ],
    workstreamRows(data.requirements),
  );
  addSheet(
    wb,
    TRACKER_SHEETS.components,
    [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Layer', key: 'layer', width: 20 },
      { header: 'Version pinned', key: 'versionPinned', width: 16 },
      { header: 'Licence', key: 'licence', width: 18 },
      { header: 'Runs as', key: 'runsAs', width: 12 },
      { header: 'Air-gap ready', key: 'airGapReady', width: 14 },
      { header: 'Replaced-by option', key: 'replacedByOption', width: 28 },
    ],
    data.components as unknown as Array<Record<string, unknown>>,
  );
  addSheet(
    wb,
    TRACKER_SHEETS.contracts,
    [
      { header: 'Name', key: 'name', width: 16 },
      { header: 'File', key: 'file', width: 44 },
      { header: 'Version', key: 'version', width: 10 },
      { header: 'Frozen on', key: 'frozenOn', width: 12 },
      { header: 'Last ADR', key: 'lastAdr', width: 12 },
    ],
    data.contracts as unknown as Array<Record<string, unknown>>,
  );
  addSheet(
    wb,
    TRACKER_SHEETS.decisions,
    [
      { header: 'ADR number', key: 'adr', width: 12 },
      { header: 'Title', key: 'title', width: 60 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Link', key: 'link', width: 44 },
    ],
    data.decisions as unknown as Array<Record<string, unknown>>,
  );
  addSheet(
    wb,
    TRACKER_SHEETS.risks,
    [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Risk', key: 'risk', width: 60 },
      { header: 'Likelihood', key: 'likelihood', width: 12 },
      { header: 'Impact', key: 'impact', width: 10 },
      { header: 'Mitigation', key: 'mitigation', width: 60 },
      { header: 'Owner', key: 'owner', width: 14 },
      { header: 'Status', key: 'status', width: 12 },
    ],
    data.risks as unknown as Array<Record<string, unknown>>,
  );
  addSheet(
    wb,
    TRACKER_SHEETS.tests,
    [
      { header: 'Test ID', key: 'id', width: 10 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Covers REQ IDs', key: 'covers', width: 40 },
      { header: 'Last run', key: 'lastRun', width: 14 },
      { header: 'Result', key: 'result', width: 10 },
      { header: 'Duration', key: 'durationMs', width: 10 },
    ],
    data.tests.map((t) => ({ ...t, covers: t.covers.join(LIST_SEPARATOR) })),
  );
  addSheet(
    wb,
    TRACKER_SHEETS.sessions,
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Session summary', key: 'summary', width: 90 },
      { header: 'REQs touched', key: 'reqsTouched', width: 40 },
      { header: 'Commits', key: 'commits', width: 30 },
      { header: 'Blockers raised', key: 'blockers', width: 40 },
    ],
    data.sessions.map((s) => ({ ...s, reqsTouched: s.reqsTouched.join(LIST_SEPARATOR), commits: s.commits.join(LIST_SEPARATOR) })),
  );
  const dash = wb.addWorksheet(TRACKER_SHEETS.dashboard);
  for (const row of dashboardRows(data)) dash.addRow(row);
  dash.getColumn(1).width = 34;
  for (let c = 2; c <= 9; c++) dash.getColumn(c).width = 14;
  dash.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(path);
}

export function workbookExists(path: string): boolean {
  return existsSync(path);
}
