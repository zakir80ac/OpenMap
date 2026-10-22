// T-049 REQ-CORE-013 — control characters captured by collectors never reach identity, checksum or
// Postgres jsonb (which rejects U+0000).
import { describe, expect, it } from 'vitest';
import { sanitizeResult, sanitizeString } from './sanitize.js';

describe('sanitize', () => {
  it('strips NUL and C0 controls but keeps tabs and newlines', () => {
    expect(sanitizeString('SSH-2.0\u0000\u0001-OpenSSH\t9.6\n')).toBe('SSH-2.0-OpenSSH\t9.6\n');
  });

  it('cleans every observed string of a result without mutating the input', () => {
    const result = {
      jobId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222', tenantId: '33333333-3333-4333-8333-333333333333', collectorId: 'port_scan', nodeId: 'n', status: 'success' as const,
      startedAt: '2026-10-22T00:00:00.000Z', finishedAt: '2026-10-22T00:00:01.000Z',
      cis: [{ type: 'listening_service' as const, identity: { hostRef: 'h\u0000', protocol: 'tcp', port: '5432' }, name: 'tcp/5432\u0000', attributes: { banner: 'N\u0000\u0003', nested: { list: ['a\u0000'] } }, tags: ['x\u0000'], externalIds: [], observedAt: '2026-10-22T00:00:00.000Z' }],
      relationships: [{ type: 'runs_on' as const, from: { type: 'listening_service' as const, identity: { hostRef: 'h\u0000' } }, to: { type: 'unknown' as const, identity: { address: '127.0.0.1' } }, attributes: { note: '\u0000' }, observedAt: '2026-10-22T00:00:00.000Z' }],
      evidence: [], errors: [{ code: 'parse_error' as const, message: 'bad\u0000', retryable: false }],
      metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 1, relationshipsEmitted: 1, durationMs: 1 }, contractVersion: '0.1.0',
    };
    const clean = sanitizeResult(result);
    expect(clean.cis[0]?.identity['hostRef']).toBe('h');
    expect(clean.cis[0]?.name).toBe('tcp/5432');
    expect(clean.cis[0]?.attributes['banner']).toBe('N');
    expect((clean.cis[0]?.attributes['nested'] as { list: string[] }).list[0]).toBe('a');
    expect(clean.cis[0]?.tags[0]).toBe('x');
    expect((clean.relationships[0]?.from as { identity: Record<string, string> }).identity['hostRef']).toBe('h');
    expect(clean.errors[0]?.message).toBe('bad');
    expect(result.cis[0]?.name).toBe('tcp/5432\u0000');
  });
});
