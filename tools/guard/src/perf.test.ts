// T-612 REQ-PERF-005 REQ-CORE-008 — the guard's perf budget rule over a results directory: results within budget pass,
// one over budget and one that is not a result are findings, a required result no file carries is a finding, and the
// --require-perf flag is read from the command line.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { perfFindings, requiredFromArgs } from './perf.js';

let dir = '';
const write = (name: string, body: unknown): void => writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('guard perf budgets', () => {
  it('passes results within budget and names the ones over it', () => {
    dir = mkdtempSync(join(tmpdir(), 'guard-perf-'));
    write('screen-interaction.json', { name: 'screen-interaction', p95Ms: 33.7 });
    write('impact-query.json', { name: 'impact-query', p95Ms: 1250 });
    write('lighthouse.json', { name: 'lighthouse', pages: [{ label: 'cmdb', performance: 0.97, accessibility: 0.9, bestPractices: 1 }] });
    const findings = perfFindings(dir);
    expect(findings.map((f) => [f.rule, f.file, f.message])).toEqual([
      ['perf-budget', 'tools/perf/results/impact-query.json', 'impact-query p95Ms 1250 over 1000'],
      ['perf-budget', 'tools/perf/results/lighthouse.json', 'cmdb lighthouse accessibility 0.9 under 0.95'],
    ]);
  });

  it('reports a file that is not a result, and a required result that was not written', () => {
    dir = mkdtempSync(join(tmpdir(), 'guard-perf-'));
    write('graph-render.json', '{"name": "graph-render", "fps": ');
    write('telemetry-fleet.json', { name: 'telemetry-fleet', p95Ms: 61 });
    const findings = perfFindings(dir, ['telemetry-fleet', 'impact-query']);
    expect(findings.map((f) => f.rule)).toEqual(['perf-result', 'perf-missing']);
    expect(findings[1]?.message).toBe('required perf result impact-query was not written');
  });

  it('finds nothing to judge without a results directory, unless results are required', () => {
    expect(perfFindings(join(tmpdir(), 'guard-perf-absent-' + String(process.pid)))).toEqual([]);
    expect(perfFindings(join(tmpdir(), 'guard-perf-absent-' + String(process.pid)), ['lighthouse'])).toHaveLength(1);
  });

  it('reads --require-perf', () => {
    expect(requiredFromArgs(['node', 'cli.ts', '--perf-only', '--require-perf', 'impact-query, telemetry-fleet'])).toEqual([
      'impact-query',
      'telemetry-fleet',
    ]);
    expect(requiredFromArgs(['node', 'cli.ts'])).toEqual([]);
  });
});
