// REQ-CORE-010 — versioned migration files: discovery, ordering, statement splitting and
// parameter substitution shared by the ClickHouse and Memgraph runners.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root, resolved relative to this module so it works from src/ (tsx) and dist/ (node). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLICKHOUSE_DIR = join(PACKAGE_ROOT, 'clickhouse');
export const MEMGRAPH_DIR = join(PACKAGE_ROOT, 'memgraph');

/** `NNNN_name.ext`: four-digit version prefix, then a snake-case name. */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)$/;

export interface MigrationFile {
  /** File name without extension, e.g. `0001_init`; recorded as the applied version. */
  version: string;
  path: string;
}

/** Lists `*.<extension>` files in a directory sorted by version, rejecting misnamed or duplicate versions. */
export function listMigrationFiles(dir: string, extension: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => extname(f) === extension)
    .map((f) => ({ version: basename(f, extension), path: join(dir, f) }))
    .sort((a, b) => a.version.localeCompare(b.version));
  const seen = new Set<string>();
  for (const f of files) {
    const m = MIGRATION_FILE_PATTERN.exec(f.version);
    if (!m) throw new Error('migration file name must match NNNN_name' + extension + ': ' + f.path);
    const prefix = m[1] ?? '';
    if (seen.has(prefix)) throw new Error('duplicate migration version ' + prefix + ' in ' + dir);
    seen.add(prefix);
  }
  return files;
}

/**
 * Splits a file into statements: lines starting with `lineComment` are dropped, then the text is
 * split on `;` at a line end. Empty statements are removed.
 */
export function splitStatements(text: string, lineComment: string): string[] {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(lineComment))
    .join('\n');
  return body
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Replaces every `{key}` with params[key]; an unknown token is an error so a typo never reaches the database. */
export function substitute(text: string, params: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (token, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error('unknown substitution parameter ' + token);
    return value;
  });
}

/** Reads a migration file and returns its ready-to-run statements. */
export function loadStatements(file: MigrationFile, lineComment: string, params: Record<string, string>): string[] {
  return splitStatements(readFileSync(file.path, 'utf8'), lineComment).map((s) => substitute(s, params));
}
