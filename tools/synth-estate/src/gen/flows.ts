// REQ-QA-001 — flow records: communicates_with relationships observed by IPFIX exporters on the
// core switches. Application tiers talk web → api → db and api → SSO; every host and VM talks to
// DNS and the monitoring server.
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_DAY, MS_PER_HOUR } from '../time.js';
import { type ListeningRec, type SiteWorld, type World } from '../world.js';

const FLOW_WINDOW_DAYS = 30;
const DNS_FLOWS: readonly [number, number] = [200, 20_000];
const MONITORING_FLOWS: readonly [number, number] = [1_000, 50_000];
const APP_FLOWS: readonly [number, number] = [5_000, 2_000_000];
const BYTES_PER_FLOW: readonly [number, number] = [400, 60_000];
const PACKETS_PER_FLOW: readonly [number, number] = [4, 120];

function flowSlot(world: World, site: SiteWorld): Slot {
  const exporter = site.cores[0]?.sysName ?? site.short + '-core-01';
  return world.b.slotFor('netflow|' + site.nodeId, {
    family: 'netflow',
    collectorId: 'netflow-ipfix',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'flow_source', value: exporter, label: site.def.code + ' IPFIX exporter' },
    evidenceKind: 'flow_sample',
  });
}

function edge(world: World, rng: Rng, site: SiteWorld, fromIdx: number, toIdx: number, protocol: string, port: number, flows: readonly [number, number]): void {
  const slot = flowSlot(world, site);
  const count = rng.int(flows[0], flows[1]);
  world.b.countPrimary(slot);
  world.b.rel(slot, 'communicates_with', fromIdx, toIdx, {
    protocol,
    dstPort: port,
    flows: count,
    bytes: count * rng.int(BYTES_PER_FLOW[0], BYTES_PER_FLOW[1]),
    packets: count * rng.int(PACKETS_PER_FLOW[0], PACKETS_PER_FLOW[1]),
    firstSeen: isoAt(-rng.int(1, FLOW_WINDOW_DAYS) * MS_PER_DAY),
    lastSeen: isoAt(-rng.int(0, 3) * MS_PER_HOUR),
    exporter: slot.target.value,
  });
}

function toListeners(world: World, rng: Rng, site: SiteWorld, sources: readonly number[], listeners: readonly ListeningRec[], flows: readonly [number, number]): void {
  for (const from of sources) {
    for (const l of listeners) {
      if (l.computeIdx === from) continue;
      edge(world, rng, site, from, l.idx, l.protocol, l.port, flows);
    }
  }
}

export function generateFlows(world: World, rng: Rng): void {
  const auth = world.authApp;
  const authListeners = auth?.components.find((c) => c.tier === 'auth')?.listeners ?? [];
  for (const app of world.applications) {
    const web = app.components.find((c) => c.tier === 'web');
    const api = app.components.find((c) => c.tier === 'api' || c.tier === 'auth');
    const db = app.components.find((c) => c.tier === 'db');
    if (web && api) {
      if (api.listeners.length > 0) toListeners(world, rng, app.site, web.computeIdx, api.listeners, APP_FLOWS);
      else if (api.k8sServiceIdx !== null) for (const from of web.computeIdx) edge(world, rng, app.site, from, api.k8sServiceIdx, 'tcp', 8443, APP_FLOWS);
    }
    if (api && db) toListeners(world, rng, app.site, api.computeIdx, db.listeners, APP_FLOWS);
    if (api && app !== auth && authListeners.length > 0) toListeners(world, rng, app.site, api.computeIdx, authListeners, APP_FLOWS);
  }

  const dns = world.infraListeners.get('infra-dns') ?? [];
  const monitoring = world.infraListeners.get('infra-monitoring') ?? [];
  for (const site of world.sites) {
    if (site.hosts.length === 0 && site.vms.length === 0) continue;
    const localDns = dns.filter((l) => l.site === site);
    const resolvers = localDns.length > 0 ? localDns : dns;
    const computes = [...site.hosts.map((h) => h.idx), ...site.vms.map((v) => v.idx)];
    computes.forEach((from, i) => {
      const resolver = resolvers[i % Math.max(1, resolvers.length)];
      if (resolver && resolver.computeIdx !== from) edge(world, rng, site, from, resolver.idx, resolver.protocol, resolver.port, DNS_FLOWS);
      const mon = monitoring[i % Math.max(1, monitoring.length)];
      if (mon && mon.computeIdx !== from) edge(world, rng, site, from, mon.idx, mon.protocol, mon.port, MONITORING_FLOWS);
    });
  }
}
