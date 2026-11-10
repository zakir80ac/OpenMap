// T-654 REQ-INT-017 REQ-QA-001 (ADR-075) — the backup stream of the synthetic estate: Veeam jobs, Commvault plans and a
// storage policy, Rubrik SLA domains as backup_policy CIs in one result per backup server; every backed_by edge it adds
// goes from a VM or host to a backup_policy and carries the cover attributes of protection.ts; some covers are past
// their RPO, some never completed, some CIs stay unprotected; and the stream is deterministic and shifts nothing else.
import { BACKUP_COVER_ATTRIBUTES, BACKUP_POLICY_ATTRIBUTES } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { buildEstate, summarise } from './estate.js';
import { ESTATE_EPOCH_MS, MS_PER_MINUTE } from './time.js';

const SEED = 42;
const SCALE = 0.01;

describe('backup stream', () => {
  const estate = buildEstate(SEED, SCALE);
  const { builder: b } = estate;
  const policies = b.cis.filter((c) => c.type === 'backup_policy');
  const covers = b.rels.filter((r) => r.type === 'backed_by' && b.get(r.to).type === 'backup_policy');

  it('reports the policies of three backup servers, one result each', () => {
    const vendors = new Set(policies.map((p) => p.identity['vendor']));
    expect([...vendors].sort()).toEqual(['commvault', 'rubrik', 'veeam']);
    expect(policies.filter((p) => p.attributes['policyKind'] === 'sla_domain').map((p) => p.name).sort()).toEqual(['Bronze', 'Gold', 'Silver']);
    expect(policies.filter((p) => p.identity['vendor'] === 'commvault').map((p) => p.attributes['policyKind']).sort()).toEqual(['plan', 'plan', 'plan', 'storage_policy']);
    expect(policies.some((p) => p.attributes['policyKind'] === 'job')).toBe(true);
    const slots = new Set(policies.map((p) => p.slot));
    expect(slots.size).toBe(3);
    for (const s of slots) expect(b.slots[s]?.family).toBe('backup');
    for (const p of policies) {
      for (const key of Object.values(BACKUP_POLICY_ATTRIBUTES)) {
        if (['rpoMinutes', 'retentionDays', 'retentionPoints', 'lastRunAt', 'provenance'].includes(key)) continue;
        expect(p.attributes, p.name + ' ' + key).toHaveProperty(key);
      }
      expect(p.attributes['protectedObjects']).toBe(covers.filter((r) => r.to === p.idx).length);
    }
  });

  it('links VMs and hosts to policies with the cover attributes', () => {
    expect(covers.length).toBeGreaterThan(0);
    const allowed = new Set<string>(Object.values(BACKUP_COVER_ATTRIBUTES));
    for (const r of covers) {
      expect(['vm', 'host']).toContain(b.get(r.from).type);
      const a = r.attributes ?? {};
      for (const k of Object.keys(a)) expect(allowed.has(k), k).toBe(true);
      expect(a['vendor']).toBe(b.get(r.to).identity['vendor']);
      expect(typeof a['objectName']).toBe('string');
      if (a['lastGoodBackupAt'] !== undefined) expect(String(a['lastGoodBackupAt'])).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u);
    }
    // Commvault covers of database compute carry a database agent.
    expect(covers.some((r) => Array.isArray(r.attributes?.['agents']) && (r.attributes['agents'] as string[]).some((x) => ['SQL Server', 'Oracle', 'PostgreSQL'].includes(x)))).toBe(true);
  });

  it('leaves some CIs unprotected, some covers past their RPO and some never backed up', () => {
    const covered = new Set(covers.map((r) => r.from));
    const vms = b.cis.filter((c) => c.type === 'vm' && c.attributes['platform'] === 'vmware');
    expect(vms.some((v) => !covered.has(v.idx))).toBe(true);
    const ageMinutes = (r: (typeof covers)[number]): number | null => {
      const t = r.attributes?.['lastGoodBackupAt'];
      return typeof t === 'string' ? (ESTATE_EPOCH_MS - Date.parse(t)) / MS_PER_MINUTE : null;
    };
    expect(covers.some((r) => ageMinutes(r) === null)).toBe(true);
    expect(covers.some((r) => { const age = ageMinutes(r); const rpo = r.attributes?.['rpoMinutes']; return age !== null && typeof rpo === 'number' && age > rpo; })).toBe(true);
    expect(covers.some((r) => { const age = ageMinutes(r); const rpo = r.attributes?.['rpoMinutes']; return age !== null && typeof rpo === 'number' && age <= rpo; })).toBe(true);
  });

  it('is deterministic', () => {
    const again = buildEstate(SEED, SCALE);
    expect(summarise(again)).toEqual(summarise(estate));
    const json = (e: typeof estate): string => JSON.stringify(e.builder.rels.filter((r) => r.type === 'backed_by').map((r) => [e.builder.get(r.from).name, e.builder.get(r.to).name, r.attributes]));
    expect(json(again)).toBe(json(estate));
  });
});
