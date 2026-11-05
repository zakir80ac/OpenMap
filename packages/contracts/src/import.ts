// REQ-CMDB-033 REQ-CMDB-036 — the import contract (0.1.0): a spreadsheet or an existing CMDB's export becomes
// observations for the reconciler. A mapping names, per column, what the value is (the CI type, its name, an identity
// key, an attribute, tags, an external id) and gives a default type for files without a type column; a type map turns a
// source's class names (ServiceNow's `cmdb_ci_linux_server`) into CI types. Rows that do not yield a valid observation
// (no type, no name, no identity key of the type) are rejected with their row number and reason, never guessed. The
// CSV reader follows RFC 4180 (quoted fields, doubled quotes, CR LF, a BOM). Pure: the API and the console share it.
import { z } from 'zod';
import { CI_IDENTITY_KEYS, ciTypeSchema, type CiType, type ObservedCi } from './ci.js';

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** What a column holds: `name`, `type`, `tags`, `identity.<key>`, `attribute.<key>` or `external.<source>`; `ignore` skips it. */
export const IMPORT_TARGET_PATTERN = /^(?:name|type|tags|ignore|identity\.[A-Za-z][A-Za-z0-9_]*|attribute\.[A-Za-z][A-Za-z0-9_]*|external\.[a-z][a-z0-9_]*)$/;

export const importMappingSchema = z.object({
  /** Column header → target. Columns not listed are ignored. */
  columns: z.record(z.string(), z.string().regex(IMPORT_TARGET_PATTERN)),
  /** Type for rows whose type column is empty or absent. */
  defaultType: ciTypeSchema.nullable().default(null),
  /** Source class name (lower-cased) → CI type, applied to the type column before it is read as a CI type. */
  typeMap: z.record(z.string(), ciTypeSchema).default({}),
  /** Character that separates tags in the tags column. */
  tagSeparator: z.string().min(1).max(1).default(';'),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export interface RejectedRow {
  /** 1-based data row number (the header is row 0). */
  row: number;
  reason: string;
}

export interface ImportReading {
  observations: ObservedCi[];
  rejected: RejectedRow[];
  /** Observations per CI type, for the preview. */
  byType: Partial<Record<CiType, number>>;
}

/** RFC 4180 reader: rows of fields; a quoted field may hold the separator, quotes doubled and line breaks. */
export function parseCsv(text: string, separator = ','): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** A CSV field written back: quoted when it holds the separator, a quote or a line break. */
export function csvField(value: string, separator = ','): string {
  return /["\r\n]/.test(value) || value.includes(separator) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

/**
 * The ServiceNow preset: the columns of a `cmdb_ci` list export (Configuration Items → Export → CSV/Excel) and the
 * class names it uses, mapped to OpenMap. `sys_id` becomes an external id so a later sync joins the same CI.
 */
export const SERVICENOW_PRESET: ImportMapping = {
  columns: {
    sys_class_name: 'type',
    name: 'name',
    serial_number: 'identity.serialNumber',
    fqdn: 'identity.fqdn',
    mac_address: 'identity.primaryMac',
    ip_address: 'attribute.primaryIp',
    os: 'attribute.osName',
    os_version: 'attribute.osVersion',
    manufacturer: 'attribute.manufacturer',
    model_id: 'attribute.model',
    asset_tag: 'attribute.assetTag',
    location: 'attribute.location',
    cpu_count: 'attribute.cpuCount',
    ram: 'attribute.memoryMb',
    sys_id: 'external.servicenow',
  },
  defaultType: null,
  typeMap: {
    cmdb_ci_server: 'host',
    cmdb_ci_linux_server: 'host',
    cmdb_ci_win_server: 'host',
    cmdb_ci_unix_server: 'host',
    cmdb_ci_esx_server: 'hypervisor',
    cmdb_ci_vm_instance: 'vm',
    cmdb_ci_vmware_instance: 'vm',
    cmdb_ci_netgear: 'network_device',
    cmdb_ci_ip_router: 'network_device',
    cmdb_ci_ip_switch: 'network_device',
    cmdb_ci_ip_firewall: 'network_device',
    cmdb_ci_lb: 'load_balancer',
    cmdb_ci_storage_device: 'storage_array',
    cmdb_ci_appl: 'application',
    cmdb_ci_service: 'business_service',
    cmdb_ci_service_discovered: 'business_service',
  },
  tagSeparator: ';',
};

/** A mapping proposed from the headers: a header named like a target (case and separators ignored) maps to it. */
export function suggestMapping(headers: readonly string[]): ImportMapping {
  const lower = new Set(headers.map((h) => h.toLowerCase()));
  if (lower.has('sys_class_name') && lower.has('sys_id')) {
    const columns: Record<string, string> = {};
    for (const h of headers) {
      const target = SERVICENOW_PRESET.columns[h.toLowerCase()];
      if (target !== undefined) columns[h] = target;
    }
    return { ...SERVICENOW_PRESET, columns };
  }
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known: Record<string, string> = { name: 'name', type: 'type', citype: 'type', tags: 'tags' };
  for (const keys of Object.values(CI_IDENTITY_KEYS)) for (const k of keys) known[squash(k)] ??= 'identity.' + k;
  const columns: Record<string, string> = {};
  for (const h of headers) {
    // An OpenMap export names its columns by their target already (identity.serialNumber, attribute.osName).
    if (IMPORT_TARGET_PATTERN.test(h)) {
      columns[h] = h;
      continue;
    }
    const target = known[squash(h)];
    columns[h] = target ?? (attributeKey(h) === null ? 'ignore' : 'attribute.' + String(attributeKey(h)));
  }
  return { columns, defaultType: null, typeMap: {}, tagSeparator: ';' };
}

/** A header as an attribute key: its words in camelCase ("Purchase date" → purchaseDate), or null when it has none. */
export function attributeKey(header: string): string | null {
  const words = header.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
  const first = words.findIndex((w) => /^[A-Za-z]/.test(w));
  if (first < 0) return null;
  return words
    .slice(first)
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

function scalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return t;
}

/** Turns rows (the header first) into observations through the mapping; every row is accepted or rejected with a reason. */
export function readImport(rows: readonly (readonly string[])[], mapping: ImportMapping, observedAt: string): ImportReading {
  const [header = [], ...data] = rows;
  const targets = header.map((h) => mapping.columns[h] ?? 'ignore');
  const observations: ObservedCi[] = [];
  const rejected: RejectedRow[] = [];
  const byType: Partial<Record<CiType, number>> = {};
  data.forEach((cells, index) => {
    const row = index + 1;
    let typeText = '';
    let name = '';
    const identity: Record<string, string> = {};
    const attributes: Record<string, string | number | boolean> = {};
    const tags: string[] = [];
    const externalIds: Array<{ source: string; id: string }> = [];
    targets.forEach((target, col) => {
      const value = (cells[col] ?? '').trim();
      if (value === '' || target === 'ignore') return;
      if (target === 'type') typeText = value;
      else if (target === 'name') name = value;
      else if (target === 'tags') tags.push(...value.split(mapping.tagSeparator).map((t) => t.trim()).filter((t) => t !== ''));
      else if (target.startsWith('identity.')) identity[target.slice('identity.'.length)] = value;
      else if (target.startsWith('attribute.')) attributes[target.slice('attribute.'.length)] = scalar(value);
      else if (target.startsWith('external.')) externalIds.push({ source: target.slice('external.'.length), id: value });
    });
    const mapped = typeText === '' ? null : (mapping.typeMap[typeText.toLowerCase()] ?? typeText);
    const parsedType = ciTypeSchema.safeParse(mapped ?? mapping.defaultType);
    if (!parsedType.success) {
      rejected.push({ row, reason: typeText === '' ? 'no type and no default type' : 'unknown type ' + typeText });
      return;
    }
    const type = parsedType.data;
    if (name === '') {
      rejected.push({ row, reason: 'no name' });
      return;
    }
    // The type's identity keys decide whether the reconciler can join the row to a CI; `name` stands in for types
    // identified by name (applications, business services).
    const keys: readonly string[] = CI_IDENTITY_KEYS[type];
    if (keys.includes('name') && identity['name'] === undefined) identity['name'] = name;
    const usable = Object.fromEntries(Object.entries(identity).filter(([k]) => keys.includes(k)));
    for (const k of Object.keys(identity)) if (!keys.includes(k)) attributes[k] = identity[k] ?? '';
    if (Object.keys(usable).length === 0) {
      rejected.push({ row, reason: 'no identity key of ' + type + ' (' + keys.join(', ') + ')' });
      return;
    }
    observations.push({ type, identity: usable, name, attributes, tags: [...new Set(tags)], externalIds, observedAt });
    byType[type] = (byType[type] ?? 0) + 1;
  });
  return { observations, rejected, byType };
}
