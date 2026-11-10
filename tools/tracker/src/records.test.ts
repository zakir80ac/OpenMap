// T-456 REQ-CORE-007 — the Decisions and Contracts sheets: a decision row is read from its ADR's header, a contract row
// records the version a contract moved to, and both replace an earlier row instead of adding a second.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_PATHS } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { adrFile, componentRow, contractRow, decisionRow, parseAdrHeader, upsertComponent, upsertContract, upsertDecision } from './records.js';
import type { ContractRow, Decision } from './model.js';

const repoRoot = resolve(process.cwd(), '..', '..');
const adrDir = join(repoRoot, REPO_PATHS.adrDir);
const today = '2026-11-07';

describe('tracker decisions and contracts', () => {
  it('reads title, status and date from the ADRs in docs/adr', () => {
    for (const adr of ['ADR-001', 'ADR-043', 'ADR-044', 'ADR-045']) {
      const link = adrFile(adrDir, REPO_PATHS.adrDir, adr);
      expect(link, adr).toMatch(new RegExp('^docs/adr/' + adr + '-.+\\.md$'));
      const header = parseAdrHeader(adr, readFileSync(join(repoRoot, link ?? ''), 'utf8'));
      expect(header.status, adr).toBe('Accepted');
      expect(header.date, adr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(header.title.startsWith(adr), adr).toBe(false);
      expect(header.title.length, adr).toBeGreaterThan(0);
    }
    const adr045 = parseAdrHeader('ADR-045', readFileSync(join(repoRoot, adrFile(adrDir, REPO_PATHS.adrDir, 'ADR-045') ?? ''), 'utf8'));
    expect(adr045).toEqual({ title: 'Reconciliation resolves `*Ref` values and scopes issuer-bound global keys', status: 'Accepted', date: '2026-11-07' });
    expect(adrFile(adrDir, REPO_PATHS.adrDir, 'ADR-999')).toBeUndefined();
  });

  it('lets flags override the header, and rejects what the sheet cannot hold', () => {
    const header = parseAdrHeader('ADR-050', '# ADR-050 — A decision\n\nStatus: Proposed · Date: 2026-11-08\n');
    expect(header).toEqual({ title: 'A decision', status: 'Proposed', date: '2026-11-08' });
    expect(decisionRow({ adr: 'ADR-050', status: 'Accepted', link: 'docs/adr/ADR-050-a.md' }, header, undefined, today)).toEqual({ adr: 'ADR-050', title: 'A decision', status: 'Accepted', date: '2026-11-08', link: 'docs/adr/ADR-050-a.md' });
    expect(() => decisionRow({ adr: 'ADR-050', status: 'Maybe' }, header, undefined, today)).toThrow();
    expect(() => decisionRow({ adr: '45' }, header, undefined, today)).toThrow(/ADR-045/);
    expect(() => decisionRow({ adr: 'ADR-050', date: '7 Nov' }, header, undefined, today)).toThrow(/YYYY-MM-DD/);
    expect(() => decisionRow({ adr: 'ADR-050' }, undefined, undefined, today)).toThrow();
  });

  it('replaces a decision by its number and keeps the sheet in ADR order', () => {
    const a: Decision = { adr: 'ADR-002', title: 'two', status: 'Accepted', date: today, link: '' };
    const b: Decision = { adr: 'ADR-001', title: 'one', status: 'Accepted', date: today, link: '' };
    const rows = upsertDecision(upsertDecision([a], b), { ...a, status: 'Superseded' });
    expect(rows.map((r) => r.adr + ' ' + r.status)).toEqual(['ADR-001 Accepted', 'ADR-002 Superseded']);
  });

  it('moves a contract to a new version, keeps what is not given, and needs a version', () => {
    const ci: ContractRow = { name: 'ci', file: 'packages/contracts/src/ci.ts', version: '0.1.0', frozenOn: '', lastAdr: 'ADR-002' };
    const moved = contractRow({ name: 'ci', version: '0.7.0', adr: 'ADR-045' }, ci);
    expect(moved).toEqual({ name: 'ci', file: 'packages/contracts/src/ci.ts', version: '0.7.0', frozenOn: '', lastAdr: 'ADR-045' });
    const rows = upsertContract([ci, { ...ci, name: 'event' }], moved);
    expect(rows.map((r) => r.name + ' ' + r.version)).toEqual(['ci 0.7.0', 'event 0.1.0']);
    expect(upsertContract(rows, contractRow({ name: 'dashboard', version: '0.1.0', file: 'packages/contracts/src/dashboard.ts' }, undefined)).map((r) => r.name)).toEqual(['ci', 'event', 'dashboard']);
    expect(() => contractRow({ name: 'ci', version: '0.7' }, ci)).toThrow(/x\.y\.z/);
    expect(() => contractRow({ name: 'new' }, undefined)).toThrow(/version/);
    expect(() => contractRow({ name: 'ci', adr: 'adr45' }, ci)).toThrow(/ADR-045/);
  });
});

describe('components (T-583)', () => {
  const pg = { name: 'PostgreSQL', layer: 'System of record', versionPinned: '17', licence: 'PostgreSQL', runsAs: 'service' as const, airGapReady: 'Y' as const, replacedByOption: '' };
  it('updates the given fields of an existing component and keeps the rest', () => {
    const row = componentRow({ name: 'PostgreSQL', version: '17.11.1 (Percona, pg_tde)' }, pg);
    expect(row).toEqual({ ...pg, versionPinned: '17.11.1 (Percona, pg_tde)' });
    expect(upsertComponent([pg], row)).toEqual([row]);
  });
  it('needs every field for a new component, and checks runs-as and air-gap', () => {
    expect(() => componentRow({ name: '@peculiar/x509', layer: 'Node PKI' }, undefined)).toThrow(/versionPinned/u);
    expect(() => componentRow({ name: 'x', layer: 'l', version: '1', licence: 'MIT', runsAs: 'daemon', airGap: 'Y' }, undefined)).toThrow(/runsAs/u);
    const lib = componentRow({ name: '@peculiar/x509', layer: 'Node PKI', version: '1.12.3', licence: 'MIT', runsAs: 'library', airGap: 'Y' }, undefined);
    expect(upsertComponent([pg], lib).map((r) => r.name)).toEqual(['PostgreSQL', '@peculiar/x509']);
  });
});
