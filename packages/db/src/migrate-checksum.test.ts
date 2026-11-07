// T-447 REQ-CORE-009 — a migration applied from a CRLF working copy is the same migration, not an edit.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareChecksum, lineEndingChecksums, listPostgresMigrations } from './migrate-postgres.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration checksums', () => {
  const sql = 'CREATE TABLE "a" (\n  "id" TEXT\n);\n';
  const migration = { name: '0099_example', checksum: hash(sql), sql };

  it('treats the committed checksum as the same migration', () => {
    expect(compareChecksum(hash(sql), migration)).toBe('same');
  });

  it('recognises the CRLF copy of the same SQL as a line-ending difference', () => {
    expect(compareChecksum(hash(sql.replace(/\n/g, '\r\n')), migration)).toBe('line_endings');
    expect(lineEndingChecksums(sql)).toEqual([hash(sql), hash(sql.replace(/\n/g, '\r\n'))]);
  });

  it('still reports a changed statement as an edit', () => {
    expect(compareChecksum(hash(sql.replace('TEXT', 'INTEGER')), migration)).toBe('edited');
  });

  it('reads every committed migration with LF line endings', () => {
    for (const m of listPostgresMigrations()) expect(m.sql.includes('\r\n'), m.name).toBe(false);
  });
});
