// REQ-INT-017 REQ-QA-001 — backup and DR awareness (ADR-075) as the backup collector reports it: three backup servers at
// the primary site, a Veeam Backup & Replication server (jobs per site: application VMs every four hours, the rest
// daily), a Commvault CommServe (Server Gold, Server Silver and Database Gold plans, a legacy storage policy) and a Rubrik
// cluster (Gold, Silver and Bronze SLA domains). Each policy is a backup_policy CI; each CI it protects has a backed_by
// edge to it with the last good backup, restore points, RPO and retention. VMware VMs are imaged by Veeam or Rubrik or
// left unprotected; bare-metal servers are protected by Commvault's File System agent, database compute by its database
// agents as well, a few by Rubrik filesets. A few covers are past their RPO, a few have never completed a backup.
// The attributes are exactly what the collector derives from each product's API, so the simulators can render the API
// from the estate and the collector's result reproduces it.
import type { Attributes, CiType } from '@openmap/contracts';
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_MINUTE } from '../time.js';
import { fqdnOf, primarySite, type World } from '../world.js';

type Vendor = 'veeam' | 'commvault' | 'rubrik';
type Kind = 'job' | 'plan' | 'storage_policy' | 'sla_domain';

interface PolicyDef {
  vendor: Vendor;
  id: string;
  name: string;
  kind: Kind;
  rpoMinutes: number | null;
  retentionDays: number | null;
  retentionPoints: number | null;
  idx: number;
  slot: Slot;
  /** Covers, filled as CIs are assigned. */
  covers: number;
  lastRunMs: number | null;
  lastResult: string;
}

/** Shares of VMware VMs imaged by Veeam and by Rubrik (cumulative); the rest are unprotected. */
const VEEAM_SHARE = 0.6;
const RUBRIK_SHARE = 0.85;
/** Share of bare-metal servers Commvault protects; of the rest, the share Rubrik protects with a fileset. */
const COMMVAULT_SHARE = 0.7;
const FILESET_SHARE = 0.3;
/** Share of Commvault servers on the legacy storage policy rather than a plan. */
const LEGACY_SHARE = 0.05;
/** Share of unassigned servers on the Server Gold plan (servers of an application always are). */
const GOLD_SHARE = 0.4;
/** Covers past their RPO, and covers that never completed a backup. */
const STALE_SHARE = 0.04;
const NEVER_SHARE = 0.02;
/** A healthy cover's age as a share of its RPO; a stale one's as a multiple. */
const FRESH_AGE: readonly [number, number] = [0.05, 0.9];
const STALE_AGE: readonly [number, number] = [1.5, 6];
/** Restore points kept per cover in the simulated history. */
const POINTS: readonly [number, number] = [1, 8];
/** Policy runs with warnings (Veeam jobs). */
const WARNING_SHARE = 0.1;
/** The default RPO when a policy states none (BACKUP_AWARENESS.defaultRpoMinutes), for spacing history. */
const DEFAULT_RPO = 1440;
const HOURLY = 60;
const FOUR_HOURS = 240;
const TWELVE_HOURS = 720;
const DAILY = 1440;

const DB_AGENT: Record<string, string> = { sqlserver: 'SQL Server', oracle: 'Oracle', postgresql: 'PostgreSQL' };
const FILE_SYSTEM = 'File System';
const DB_BACKUPSET: Record<string, string> = { sqlserver: 'MSSQLSERVER', oracle: 'ORCL', postgresql: 'pgcluster' };

/** RFC 3339 at whole seconds, as the collector prints instants. */
function rfc(ms: number): string {
  return isoAt(Math.floor(ms / 1000) * 1000).replace('.000Z', 'Z');
}

function serverSlot(world: World, vendor: Vendor, host: string, label: string): Slot {
  const site = primarySite(world);
  return world.b.slotFor('backup-' + vendor, {
    family: 'backup',
    collectorId: 'backup',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: host, label },
    evidenceKind: 'api_response',
  });
}

export interface BackupSummary {
  policies: number;
  covers: number;
}

export function generateBackup(world: World, rng: Rng): BackupSummary {
  const { b } = world;
  const site = primarySite(world);
  const code = site.def.code;
  const servers: Record<Vendor, { host: string; serverId: string; slot: Slot }> = {
    veeam: { host: fqdnOf('vbr-' + site.short + '-01'), serverId: rng.uuid(), slot: serverSlot(world, 'veeam', fqdnOf('vbr-' + site.short + '-01'), 'Veeam Backup & Replication') },
    commvault: { host: fqdnOf('cvcs-' + site.short + '-01'), serverId: fqdnOf('cvcs-' + site.short + '-01'), slot: serverSlot(world, 'commvault', fqdnOf('cvcs-' + site.short + '-01'), 'Commvault CommServe') },
    rubrik: { host: fqdnOf('rbk-' + site.short + '-01'), serverId: rng.uuid(), slot: serverSlot(world, 'rubrik', fqdnOf('rbk-' + site.short + '-01'), 'Rubrik CDM') },
  };
  const policies: PolicyDef[] = [];
  const policy = (vendor: Vendor, id: string, name: string, kind: Kind, rpo: number | null, days: number | null, points: number | null = null): PolicyDef => {
    const s = servers[vendor];
    const def: PolicyDef = { vendor, id, name, kind, rpoMinutes: rpo, retentionDays: days, retentionPoints: points, idx: -1, slot: s.slot, covers: 0, lastRunMs: null, lastResult: 'none' };
    policies.push(def);
    return def;
  };

  // Veeam: two jobs per site that runs VMware VMs.
  const veeamJobs = new Map<string, { tier1: PolicyDef; daily: PolicyDef }>();
  for (const s of world.sites) {
    if (!s.vms.some((v) => v.hypervisor.platform === 'vmware')) continue;
    veeamJobs.set(s.def.code, {
      tier1: policy('veeam', rng.uuid(), s.def.code + ' application VMs 4h', 'job', FOUR_HOURS, 14),
      daily: policy('veeam', rng.uuid(), s.def.code + ' VMs daily', 'job', DAILY, null, 14),
    });
  }
  const gold = policy('rubrik', rng.uuid(), 'Gold', 'sla_domain', FOUR_HOURS, 360);
  const silver = policy('rubrik', rng.uuid(), 'Silver', 'sla_domain', TWELVE_HOURS, 30);
  const bronze = policy('rubrik', rng.uuid(), 'Bronze', 'sla_domain', DAILY, 7);
  const serverGold = policy('commvault', 'plan:1', 'Server Gold', 'plan', FOUR_HOURS, 30);
  const serverSilver = policy('commvault', 'plan:2', 'Server Silver', 'plan', DAILY, 14);
  const dbGold = policy('commvault', 'plan:3', 'Database Gold', 'plan', HOURLY, 35);
  const legacy = policy('commvault', 'sp:11', 'SP-Legacy', 'storage_policy', null, null);

  // Database compute, from the clusters' hosted_on edges: the engine of each node.
  const dbEngine = new Map<number, string>();
  for (const r of b.rels) {
    if (r.type !== 'hosted_on') continue;
    const from = b.get(r.from);
    if (from.type !== 'database_cluster') continue;
    const engine = from.attributes['engine'];
    if (typeof engine === 'string') dbEngine.set(r.to, engine);
  }

  interface CoverSpec {
    lastGood: number | null;
    lastBackup: number | null;
    lastResult: string;
    points: number;
    agents?: string[];
    subclients?: string[];
  }
  const ageOf = (p: PolicyDef): { lastGood: number | null; points: number } => {
    const rpo = p.rpoMinutes ?? DEFAULT_RPO;
    const roll = rng.next();
    if (roll < NEVER_SHARE) return { lastGood: null, points: 0 };
    const share = roll < NEVER_SHARE + STALE_SHARE ? rng.float(STALE_AGE[0], STALE_AGE[1]) : rng.float(FRESH_AGE[0], FRESH_AGE[1]);
    return { lastGood: -Math.round(share * rpo) * MS_PER_MINUTE, points: rng.int(POINTS[0], POINTS[1]) };
  };
  const cover = (ciIdx: number, p: PolicyDef, spec: CoverSpec): void => {
    const ci = b.get(ciIdx);
    const attrs: Attributes = { vendor: p.vendor, objectName: objectName(ci.type, ci.name, ci.attributes, p.vendor), lastResult: spec.lastResult, restorePoints: spec.points };
    if (spec.lastGood !== null) attrs['lastGoodBackupAt'] = rfc(spec.lastGood);
    if (spec.lastBackup !== null) attrs['lastBackupAt'] = rfc(spec.lastBackup);
    if (p.rpoMinutes !== null) attrs['rpoMinutes'] = p.rpoMinutes;
    if (p.retentionDays !== null) attrs['retentionDays'] = p.retentionDays;
    if (spec.agents) attrs['agents'] = [...spec.agents].sort();
    if (spec.subclients) attrs['subclients'] = [...spec.subclients].sort();
    pending.push({ ciIdx, p, attrs });
    p.covers++;
    const run = spec.lastBackup ?? spec.lastGood;
    if (run !== null && (p.lastRunMs === null || run > p.lastRunMs)) {
      p.lastRunMs = run;
      if (p.vendor !== 'veeam') p.lastResult = spec.lastResult;
    }
  };
  const pending: Array<{ ciIdx: number; p: PolicyDef; attrs: Attributes }> = [];

  // Veeam job results come from the job, not the object: decide them first.
  for (const jobs of veeamJobs.values()) {
    for (const j of [jobs.tier1, jobs.daily]) {
      j.lastResult = rng.chance(WARNING_SHARE) ? 'warning' : 'success';
      j.lastRunMs = -rng.int(1, Math.max(2, (j.rpoMinutes ?? DAILY) - 1)) * MS_PER_MINUTE;
    }
  }

  for (const s of world.sites) {
    for (const vm of s.vms) {
      if (vm.hypervisor.platform !== 'vmware') continue;
      const roll = rng.next();
      const application = vm.role !== null;
      const jobs = veeamJobs.get(s.def.code);
      if (roll < VEEAM_SHARE && jobs) {
        const j = application ? jobs.tier1 : jobs.daily;
        const { lastGood, points } = ageOf(j);
        // Veeam reports the job's last result on every object it holds a restore point of; none on the rest.
        const lastRun = j.lastRunMs;
        cover(vm.idx, j, { lastGood, lastBackup: lastGood, lastResult: lastGood === null ? 'none' : j.lastResult, points });
        j.lastRunMs = lastRun;
      } else if (roll < RUBRIK_SHARE) {
        const p = application ? gold : rng.chance(0.5) ? silver : bronze;
        const { lastGood, points } = ageOf(p);
        cover(vm.idx, p, { lastGood, lastBackup: lastGood, lastResult: lastGood === null ? 'none' : 'success', points });
      }
      // Database VMs also run Commvault's database agent.
      const engine = dbEngine.get(vm.idx);
      if (engine !== undefined) commvaultCover(vm.idx, engine);
    }
    for (const host of s.hosts) {
      if (host.plan.platform !== null) continue;
      const engine = dbEngine.get(host.idx);
      if (engine !== undefined) {
        commvaultCover(host.idx, engine);
        continue;
      }
      if (rng.chance(COMMVAULT_SHARE)) {
        const p = rng.chance(LEGACY_SHARE) ? legacy : host.role !== null || rng.chance(GOLD_SHARE) ? serverGold : serverSilver;
        commvaultCover(host.idx, null, p);
      } else if (rng.chance(FILESET_SHARE)) {
        const { lastGood, points } = ageOf(bronze);
        cover(host.idx, bronze, { lastGood, lastBackup: lastGood, lastResult: lastGood === null ? 'none' : 'success', points, subclients: [filesetName(b.get(host.idx).attributes)] });
      }
    }
  }

  function commvaultCover(ciIdx: number, engine: string | null, plan: PolicyDef = dbGold): void {
    const p = engine !== null ? dbGold : plan;
    const agents = [FILE_SYSTEM];
    const subclients = [FILE_SYSTEM + '/defaultBackupSet/default'];
    if (engine !== null) {
      const agent = DB_AGENT[engine] ?? engine;
      agents.push(agent);
      subclients.push(agent + '/' + (DB_BACKUPSET[engine] ?? engine) + '/default');
    }
    const { lastGood, points } = ageOf(p);
    // A cover that never completed has one failed job; a stale one sometimes has a newer failed job.
    let lastBackup = lastGood;
    let lastResult = 'success';
    if (lastGood === null || rng.chance(STALE_SHARE)) {
      lastBackup = (lastGood ?? 0) + (lastGood === null ? -rng.int(1, HOURLY) * MS_PER_MINUTE : rng.int(1, HOURLY) * MS_PER_MINUTE);
      if (lastBackup > 0) lastBackup = -MS_PER_MINUTE;
      lastResult = 'failed';
    }
    cover(ciIdx, p, { lastGood, lastBackup, lastResult, points, agents, subclients });
  }

  for (const p of policies) {
    const s = servers[p.vendor];
    const attrs: Attributes = {
      vendor: p.vendor,
      serverId: s.serverId,
      server: s.host,
      policyId: p.id,
      policyKind: p.kind,
      enabled: true,
      lastResult: p.lastRunMs === null && p.vendor !== 'veeam' ? 'none' : p.lastResult,
      protectedObjects: p.covers,
      unmatchedObjects: 0,
      unmatchedNames: [],
    };
    if (p.rpoMinutes !== null) attrs['rpoMinutes'] = p.rpoMinutes;
    if (p.retentionDays !== null) attrs['retentionDays'] = p.retentionDays;
    if (p.retentionPoints !== null) attrs['retentionPoints'] = p.retentionPoints;
    if (p.lastRunMs !== null) attrs['lastRunAt'] = rfc(p.lastRunMs);
    const identity = { vendor: p.vendor, serverId: s.serverId, policyId: p.id };
    p.idx = b.ci(p.slot, 'backup_policy', identity, p.name, attrs, code, { tags: ['backup', p.vendor], externalIds: [{ source: p.vendor, id: p.id }], primary: true });
  }
  for (const c of pending) b.rel(c.p.slot, 'backed_by', c.ciIdx, c.p.idx, c.attrs);
  return { policies: policies.length, covers: pending.length };
}

/** The name a backup product gives the object: the VM name, a Commvault client's name, a Rubrik fileset's host name. */
function objectName(type: CiType, name: string, attributes: Attributes, vendor: Vendor): string {
  if (vendor === 'rubrik' && type === 'host') {
    const fqdn = attributes['fqdn'];
    if (typeof fqdn === 'string' && fqdn !== '') return fqdn;
  }
  return name;
}

function filesetName(attributes: Attributes): string {
  return attributes['osFamily'] === 'windows' || String(attributes['os'] ?? '').toLowerCase().includes('windows') ? 'C-drive' : 'root';
}
