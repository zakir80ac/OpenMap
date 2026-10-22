// REQ-QA-001 — applications and business services: web → api → db tiers on VMs, bare metal or
// Kubernetes, a shared SSO application every api tier authenticates against, infrastructure
// applications (DNS, monitoring, backup), database clusters with their listeners, and business
// services composed of 2–6 applications with tier, users and revenue per hour.
import { SYNTH_ESTATE } from '@openmap/constants';
import {
  APP_ARCHETYPES,
  APP_VARIANTS,
  BUSINESS_SERVICE_BASES,
  BUSINESS_SERVICE_SEGMENTS,
  BUSINESS_UNITS,
  CURRENCY,
  DB_ENGINE_PORT,
  DB_ENGINE_PROCESS,
  DB_ENGINE_PRODUCT,
  DB_ENGINE_SHORT,
  DB_ENGINE_SOFTWARE,
  INFRA_APPS,
  POOL,
  RUNTIME_PROCESS,
  SHARED_AUTH_APP,
  SOFTWARE,
  TIER_PORT,
  type AppArchetypeDef,
  type DbEngine,
  type OsDef,
  type Runtime,
} from '../catalog.js';
import type { Slot } from '../estate.js';
import { cidr, RFC1918_TEN } from '../ip.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_DAY, MS_PER_HOUR } from '../time.js';
import { fqdnOf, pad, siteOf, type ApplicationRec, type ComponentRec, type HostRec, type K8sClusterRec, type ListeningRec, type SiteWorld, type VmRec, type World } from '../world.js';
import { claimHost, claimVm } from './claim.js';
import { installSoftware, renameHost } from './hosts.js';
import { addService, addWorkload } from './kubernetes.js';
import { renameVm } from './virtualization.js';

const APPS_BASE = 360;
const WEB_INSTANCES: readonly [number, number] = [2, 4];
const API_INSTANCES: readonly [number, number] = [2, 6];
const DB_NODES: Record<DbEngine, readonly [number, number]> = { postgresql: [2, 3], oracle: [2, 2], sqlserver: [2, 3] };
const APPS_PER_SERVICE: readonly [number, number] = [2, 6];
const SERVICE_TIER_WEIGHTS: readonly number[] = [20, 35, 45];
const USERS_BY_TIER: readonly (readonly [number, number])[] = [[500_000, 5_000_000], [10_000, 500_000], [50, 10_000]];
const REVENUE_BY_TIER: readonly (readonly [number, number])[] = [[50_000, 2_000_000], [2_000, 50_000], [0, 2_000]];
const RTO_BY_TIER: readonly number[] = [15, 120, 1440];
const RPO_BY_TIER: readonly number[] = [0, 60, 1440];
const SLA_BY_TIER: readonly number[] = [99.99, 99.9, 99.5];
const COLO_SHARE = 0.15;
const DNS_PER_SITE = 2;
const MONITORING_VMS = 2;
const DB_SIZE_GB: readonly [number, number] = [20, 6000];
const HOURS_PER_DAY = 24;

type Compute = { kind: 'vm'; vm: VmRec } | { kind: 'host'; host: HostRec };

function computeIdx(c: Compute): number {
  return c.kind === 'vm' ? c.vm.idx : c.host.idx;
}
function computeRef(world: World, c: Compute): string {
  return world.b.ref(computeIdx(c));
}
function computeIp(c: Compute): string {
  return c.kind === 'vm' ? c.vm.ip : c.host.ip;
}
function computeOs(c: Compute): OsDef {
  return c.kind === 'vm' ? c.vm.os : c.host.plan.os;
}
function computeSlot(c: Compute): Slot {
  return c.kind === 'vm' ? c.vm.slot : c.host.slot;
}

function appSlot(world: World, site: SiteWorld): Slot {
  return world.b.slotFor('appmap|' + site.nodeId, {
    family: 'agent',
    collectorId: 'agent-appmap',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('appmap-' + site.short + '-01'), label: site.def.code + ' application map' },
    evidenceKind: 'agent_report',
  });
}

function dbSlot(world: World, site: SiteWorld): Slot {
  return world.b.slotFor('database|' + site.nodeId, {
    family: 'database',
    collectorId: 'database',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: cidr(RFC1918_TEN, site.def.octetBase + POOL.vms, 0, 0, 14), label: site.def.code + ' database tier' },
    evidenceKind: 'api_response',
  });
}

export function addListener(world: World, rng: Rng, slot: Slot, compute: Compute, port: number, protocol: 'tcp' | 'udp', process: string, site: SiteWorld): ListeningRec {
  const { b } = world;
  const idx = computeIdx(compute);
  const ip = computeIp(compute);
  const ref = computeRef(world, compute);
  const ciIdx = b.ci(slot, 'listening_service', { hostRef: ref, protocol, port: String(port) }, b.get(idx).name + ' ' + protocol + '/' + String(port), { port, protocol, process, pid: rng.int(400, 65_000), bindAddress: ip, state: 'LISTEN', user: process === 'w3wp' || process === 'sqlservr' ? 'NT SERVICE' : process, host: b.get(idx).name }, site.def.code, { tags: ['service'] });
  b.rel(slot, 'runs_on', ciIdx, idx);
  const rec: ListeningRec = { idx: ciIdx, computeIdx: idx, site, ip, port, protocol };
  world.listeners.push(rec);
  return rec;
}

function claimCompute(site: SiteWorld, family: OsDef['family'], preferHost: boolean): Compute | null {
  if (preferHost) {
    const host = claimHost(site, family);
    if (host) return { kind: 'host', host };
  }
  const vm = claimVm(site, family) ?? claimVm(site, 'any');
  if (vm) return { kind: 'vm', vm };
  const host = claimHost(site, family) ?? claimHost(site, 'any');
  return host ? { kind: 'host', host } : null;
}

function rename(world: World, c: Compute, name: string, role: string): void {
  if (c.kind === 'vm') renameVm(world, c.vm, name, role);
  else renameHost(world, c.host, name, role);
}

function runtimeSoftware(runtime: Runtime, family: OsDef['family']): typeof SOFTWARE[number] | undefined {
  const name = runtime === 'java' ? 'Temurin JDK' : runtime === 'dotnet' ? '.NET Runtime' : 'Node.js';
  return SOFTWARE.find((s) => s.name === name && s.on.includes(family));
}

function webSoftware(family: OsDef['family']): typeof SOFTWARE[number] | undefined {
  return SOFTWARE.find((s) => s.name === (family === 'windows' ? 'Internet Information Services' : 'NGINX'));
}

function k8sClusterFor(world: World, site: SiteWorld, environment: string): K8sClusterRec | null {
  const prefer = site.k8sClusters.filter((c) => (environment === 'uat' ? c.name.includes('nonprod') : !c.name.includes('nonprod')));
  const candidates = prefer.length > 0 ? prefer : site.k8sClusters.length > 0 ? site.k8sClusters : world.k8sClusters.filter((c) => c.site.def.cloud === null);
  const pool = candidates.length > 0 ? candidates : world.k8sClusters;
  const chosen = pool[world.applications.length % Math.max(1, pool.length)];
  return chosen ?? null;
}

interface TierResult {
  component: ComponentRec;
}

function addTier(world: World, rng: Rng, app: ApplicationRec, def: AppArchetypeDef, tier: 'web' | 'api', count: number, environment: string): TierResult {
  const { b } = world;
  const port = tier === 'web' ? TIER_PORT.web : TIER_PORT.api;
  const componentName = app.slug + '-' + tier;
  const technology = tier === 'web' ? (def.runtime === 'dotnet' ? 'IIS 10' : 'NGINX 1.26') : def.runtime === 'java' ? 'Spring Boot 3.3 / Temurin 21' : def.runtime === 'dotnet' ? 'ASP.NET Core 8' : 'Node.js 22 / Fastify';
  const compIdx = b.ci(app.slot, 'application_component', { applicationRef: app.name, name: componentName }, componentName, { tier, technology, port, protocol: 'https', instances: count, application: app.name, deployment: app.containerised ? 'kubernetes' : 'virtual_machines' }, app.site.def.code, { tags: ['application', tier] });
  b.rel(app.slot, 'contains', app.idx, compIdx);
  const component: ComponentRec = { idx: compIdx, name: componentName, tier, computeIdx: [], listeners: [], k8sServiceIdx: null };

  const cluster = app.containerised && world.k8sServiceBudget > 0 ? k8sClusterFor(world, app.site, environment) : null;
  if (cluster) {
    const image = 'registry.' + app.site.def.code.toLowerCase() + '.bank.local/' + app.slug + '/' + tier + ':' + String(rng.int(1, 9)) + '.' + String(rng.int(0, 30)) + '.' + String(rng.int(0, 9));
    const workloadIdx = addWorkload(world, rng, cluster, app.name, componentName, 'Deployment', count, image, app.name);
    const serviceIdx = addService(world, rng, cluster, app.name, componentName, port, tier === 'web' ? 'LoadBalancer' : 'ClusterIP', workloadIdx, app.name);
    world.k8sServiceBudget--;
    b.rel(app.slot, 'hosted_on', compIdx, workloadIdx);
    component.computeIdx.push(workloadIdx);
    component.k8sServiceIdx = serviceIdx;
    b.get(compIdx).attributes['cluster'] = cluster.name;
    b.get(compIdx).attributes['namespace'] = app.name;
    return { component };
  }
  b.get(compIdx).attributes['deployment'] = 'virtual_machines';
  const family: OsDef['family'] = def.runtime === 'dotnet' ? 'windows' : 'linux';
  for (let i = 0; i < count; i++) {
    const c = claimCompute(app.site, family, false);
    if (!c) break;
    rename(world, c, tier + '-' + app.site.short + '-' + app.slug + '-' + pad(i + 1, 2), app.name + '/' + tier);
    const osFamily = computeOs(c).family;
    const process = tier === 'web' ? (osFamily === 'windows' ? 'w3wp' : 'nginx') : RUNTIME_PROCESS[def.runtime];
    component.listeners.push(addListener(world, rng, app.slot, c, port, 'tcp', process, app.site));
    component.computeIdx.push(computeIdx(c));
    b.rel(app.slot, 'runs_on', compIdx, computeIdx(c));
    const sw = tier === 'web' ? webSoftware(osFamily) : runtimeSoftware(def.runtime, osFamily);
    if (sw) installSoftware(world, rng, computeSlot(c), computeIdx(c), computeRef(world, c), sw, osFamily, app.site.def.code);
  }
  return { component };
}

function addDatabaseTier(world: World, rng: Rng, app: ApplicationRec, def: AppArchetypeDef): { component: ComponentRec; clusterIdx: number } | null {
  const { b } = world;
  const engine = def.engine;
  const range = DB_NODES[engine];
  const nodeCount = rng.int(range[0], range[1]);
  const family: OsDef['family'] = engine === 'sqlserver' ? 'windows' : 'linux';
  const nodes: Compute[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const c = claimCompute(app.site, family, engine === 'oracle');
    if (!c) break;
    rename(world, c, 'db-' + app.site.short + '-' + DB_ENGINE_SHORT[engine] + '-' + app.slug + '-' + pad(i + 1, 2), app.name + '/db');
    nodes.push(c);
  }
  const primary = nodes[0];
  if (!primary) return null;
  const slot = dbSlot(world, app.site);
  const port = DB_ENGINE_PORT[engine];
  const clusterId = app.slug + '-' + app.site.short + '-' + DB_ENGINE_SHORT[engine];
  const clusterIdx = b.ci(slot, 'database_cluster', { engine, clusterId }, clusterId, { engine, product: DB_ENGINE_PRODUCT[engine], version: SOFTWARE.find((s) => s.name === DB_ENGINE_SOFTWARE[engine])?.version ?? '', nodeCount: nodes.length, haMode: engine === 'postgresql' ? 'patroni' : engine === 'oracle' ? 'rac' : 'always_on_ag', port, primaryNode: b.get(computeIdx(primary)).name, application: app.name, backupPolicy: 'daily-full-hourly-log', encryptionAtRest: true }, app.site.def.code, { tags: ['database', engine], primary: true });
  b.rel(slot, 'located_in', clusterIdx, app.site.ciIdx);
  const dbSoftware = SOFTWARE.find((s) => s.name === DB_ENGINE_SOFTWARE[engine]);
  const component: ComponentRec = { idx: -1, name: app.slug + '-db', tier: 'db', computeIdx: [], listeners: [], k8sServiceIdx: null };
  nodes.forEach((node, i) => {
    b.rel(slot, 'hosted_on', clusterIdx, computeIdx(node), { role: i === 0 ? 'primary' : 'replica' });
    component.listeners.push(addListener(world, rng, slot, node, port, 'tcp', DB_ENGINE_PROCESS[engine], app.site));
    component.computeIdx.push(computeIdx(node));
    if (dbSoftware) installSoftware(world, rng, computeSlot(node), computeIdx(node), computeRef(world, node), dbSoftware, computeOs(node).family, app.site.def.code);
  });
  const primaryRef = computeRef(world, primary);
  for (const dbName of def.dbNames) {
    const name = app.slug.replace(/-/g, '_') + '_' + dbName;
    const dbIdx = b.ci(slot, 'database', { hostRef: primaryRef, engine, name, port: String(port) }, name, { engine, name, port, sizeGb: rng.int(DB_SIZE_GB[0], DB_SIZE_GB[1]), charset: engine === 'oracle' ? 'AL32UTF8' : engine === 'sqlserver' ? 'SQL_Latin1_General_CP1_CI_AS' : 'UTF8', replicationRole: 'primary', lastBackupAt: isoAt(-rng.int(1, HOURS_PER_DAY) * MS_PER_HOUR), cluster: clusterId, owner: app.name, piiClassification: rng.pick(['restricted', 'confidential', 'internal']) }, app.site.def.code, { tags: ['database', engine] });
    b.rel(slot, 'member_of', dbIdx, clusterIdx);
    b.rel(slot, 'hosted_on', dbIdx, computeIdx(primary));
  }
  component.idx = b.ci(app.slot, 'application_component', { applicationRef: app.name, name: component.name }, component.name, { tier: 'db', technology: DB_ENGINE_PRODUCT[engine], port, protocol: 'tcp', instances: nodes.length, application: app.name, deployment: 'database_cluster' }, app.site.def.code, { tags: ['application', 'db'] });
  b.rel(app.slot, 'contains', app.idx, component.idx);
  b.rel(app.slot, 'backed_by', component.idx, clusterIdx);
  for (const idx of component.computeIdx) b.rel(app.slot, 'runs_on', component.idx, idx);
  return { component, clusterIdx };
}

function createApplication(world: World, rng: Rng, def: AppArchetypeDef, name: string, variant: string, site: SiteWorld, businessUnit: string): ApplicationRec {
  const { b } = world;
  const slot = appSlot(world, site);
  const environment = variant === 'uat' ? 'uat' : variant === 'pilot' ? 'pilot' : 'production';
  const containerised = def.containerised && world.k8sClusters.length > 0;
  const appIdx = b.ci(
    slot,
    'application',
    { name },
    name,
    { title: def.title + (variant ? ' (' + variant + ')' : ''), slug: def.slug, variant: variant || null, environment, criticality: rng.pick(['high', 'high', 'medium', 'low']), owner: businessUnit, runtime: def.runtime, databaseEngine: def.engine, containerised, version: String(rng.int(1, 12)) + '.' + String(rng.int(0, 20)) + '.' + String(rng.int(0, 9)), lifecycle: variant === 'dr' ? 'standby' : 'active', site: site.def.code, lastDeployedAt: isoAt(-rng.int(0, 90) * MS_PER_DAY) },
    site.def.code,
    { tags: ['application', environment], primary: true },
  );
  b.rel(slot, 'located_in', appIdx, site.ciIdx);
  const app: ApplicationRec = { idx: appIdx, name, slug: def.slug + (variant ? '-' + variant : ''), engine: def.engine, containerised, components: [], site, slot };

  const db = addDatabaseTier(world, rng, app, def);
  const api = addTier(world, rng, app, def, 'api', rng.int(API_INSTANCES[0], API_INSTANCES[1]), environment).component;
  const web = addTier(world, rng, app, def, 'web', rng.int(WEB_INSTANCES[0], WEB_INSTANCES[1]), environment).component;
  app.components.push(web, api);
  b.rel(slot, 'communicates_with', web.idx, api.idx, { protocol: 'https', port: TIER_PORT.api });
  if (db) {
    app.components.push(db.component);
    b.rel(slot, 'communicates_with', api.idx, db.component.idx, { protocol: 'tcp', port: DB_ENGINE_PORT[def.engine] });
    b.rel(slot, 'depends_on', appIdx, db.clusterIdx, { kind: 'database' });
  }
  const auth = world.authApp;
  if (auth && auth !== app) {
    const authApi = auth.components.find((c) => c.tier === 'api' || c.tier === 'auth');
    if (authApi) b.rel(slot, 'communicates_with', api.idx, authApi.idx, { protocol: 'https', port: TIER_PORT.api, purpose: 'oidc' });
    b.rel(slot, 'depends_on', appIdx, auth.idx, { kind: 'authentication' });
  }
  return app;
}

function addInfraApplications(world: World, rng: Rng): void {
  const { b } = world;
  const ryd = siteOf(world, 'RYD');
  const jed = siteOf(world, 'JED');
  for (const def of INFRA_APPS) {
    const slot = appSlot(world, ryd);
    const appIdx = b.ci(slot, 'application', { name: def.slug }, def.slug, { title: def.title, slug: def.slug, environment: 'production', criticality: 'high', owner: BUSINESS_UNITS[3], runtime: 'native', containerised: false, lifecycle: 'active', site: ryd.def.code }, ryd.def.code, { tags: ['application', 'infrastructure'], primary: true });
    b.rel(slot, 'located_in', appIdx, ryd.ciIdx);
    const compIdx = b.ci(slot, 'application_component', { applicationRef: def.slug, name: def.slug + '-svc' }, def.slug + '-svc', { tier: 'infra', technology: def.process, port: def.listenPort, protocol: def.protocol, application: def.slug, deployment: 'virtual_machines' }, ryd.def.code, { tags: ['application', 'infra'] });
    b.rel(slot, 'contains', appIdx, compIdx);
    const component: ComponentRec = { idx: compIdx, name: def.slug + '-svc', tier: 'infra', computeIdx: [], listeners: [], k8sServiceIdx: null };
    const placements: Array<{ site: SiteWorld; count: number; preferHost: boolean }> = def.slug === 'infra-dns' ? [{ site: ryd, count: DNS_PER_SITE, preferHost: false }, { site: jed, count: DNS_PER_SITE, preferHost: false }] : def.slug === 'infra-monitoring' ? [{ site: ryd, count: MONITORING_VMS, preferHost: false }] : [{ site: ryd, count: 1, preferHost: true }];
    const software = SOFTWARE.find((s) => (def.slug === 'infra-dns' ? s.name === 'BIND' : def.slug === 'infra-monitoring' ? s.name === 'Zabbix Server' : s.name === 'Backup and Replication'));
    for (const p of placements) {
      for (let i = 0; i < p.count; i++) {
        const c = claimCompute(p.site, def.os.family, p.preferHost);
        if (!c) break;
        const short = def.slug.replace('infra-', '').slice(0, 3);
        rename(world, c, short + '-' + p.site.short + '-' + pad(i + 1, 2), def.slug);
        component.listeners.push(addListener(world, rng, slot, c, def.listenPort, def.protocol, def.process, p.site));
        component.computeIdx.push(computeIdx(c));
        b.rel(slot, 'runs_on', compIdx, computeIdx(c));
        if (software) installSoftware(world, rng, computeSlot(c), computeIdx(c), computeRef(world, c), software, computeOs(c).family, p.site.def.code);
      }
    }
    world.infraListeners.set(def.slug, component.listeners);
    world.applications.push({ idx: appIdx, name: def.slug, slug: def.slug, engine: 'postgresql', containerised: false, components: [component], site: ryd, slot });
  }
}

export interface BusinessServiceRecord {
  name: string;
  tier: number;
  businessUnit: string;
  users: number;
  revenuePerHour: number;
  currency: string;
  criticality: string;
  rtoMinutes: number;
  rpoMinutes: number;
  slaTargetPercent: number;
  applications: string[];
  identity: { name: string };
}

export function generateApplications(world: World, rng: Rng): BusinessServiceRecord[] {
  const { b } = world;
  const ryd = siteOf(world, 'RYD');
  const jed = siteOf(world, 'JED');
  const colo = siteOf(world, 'DMM-COLO');

  world.authApp = createApplication(world, rng, SHARED_AUTH_APP, SHARED_AUTH_APP.slug, '', ryd, BUSINESS_UNITS[3]);
  for (const c of world.authApp.components) if (c.tier === 'api') c.tier = 'auth';
  world.applications.push(world.authApp);
  addInfraApplications(world, rng);

  const total = b.count(APPS_BASE);
  const businessApps: ApplicationRec[] = [];
  const used = new Set<string>();
  outer: for (const variant of APP_VARIANTS) {
    for (const def of APP_ARCHETYPES) {
      if (businessApps.length >= total) break outer;
      const name = def.slug + (variant ? '-' + variant : '');
      if (used.has(name)) continue;
      used.add(name);
      const site = variant === 'dr' ? jed : rng.chance(COLO_SHARE) ? colo : ryd;
      const bu = BUSINESS_UNITS[rng.int(0, BUSINESS_UNITS.length - 1)] ?? BUSINESS_UNITS[0];
      const app = createApplication(world, rng, def, name, variant, site, bu);
      businessApps.push(app);
      world.applications.push(app);
    }
  }

  const serviceCount = b.count(SYNTH_ESTATE.businessServices);
  const records: BusinessServiceRecord[] = [];
  const names = new Set<string>();
  const slot = appSlot(world, ryd);
  for (let i = 0; i < serviceCount; i++) {
    const base = BUSINESS_SERVICE_BASES[i % BUSINESS_SERVICE_BASES.length] ?? 'Service';
    const segment = BUSINESS_SERVICE_SEGMENTS[Math.floor(i / BUSINESS_SERVICE_BASES.length) % BUSINESS_SERVICE_SEGMENTS.length] ?? '';
    let name = segment ? base + ' (' + segment + ')' : base;
    let suffix = 2;
    while (names.has(name)) name = (segment ? base + ' (' + segment + ')' : base) + ' ' + String(suffix++);
    names.add(name);
    const tierIndex = rng.weighted(SERVICE_TIER_WEIGHTS);
    const tier = tierIndex + 1;
    const usersRange = USERS_BY_TIER[tierIndex] ?? USERS_BY_TIER[2];
    const revenueRange = REVENUE_BY_TIER[tierIndex] ?? REVENUE_BY_TIER[2];
    if (!usersRange || !revenueRange) throw new Error('tier tables incomplete');
    const users = rng.int(usersRange[0], usersRange[1]);
    const revenuePerHour = rng.int(revenueRange[0], revenueRange[1]);
    const businessUnit = BUSINESS_UNITS[rng.int(0, BUSINESS_UNITS.length - 2)] ?? BUSINESS_UNITS[0];
    const want = Math.min(businessApps.length, rng.int(APPS_PER_SERVICE[0], APPS_PER_SERVICE[1]));
    const chosen: ApplicationRec[] = [];
    const pool = [...businessApps];
    while (chosen.length < want && pool.length > 0) {
      const k = rng.int(0, pool.length - 1);
      const [app] = pool.splice(k, 1);
      if (app) chosen.push(app);
    }
    const rto = RTO_BY_TIER[tierIndex] ?? RTO_BY_TIER[2] ?? 1440;
    const rpo = RPO_BY_TIER[tierIndex] ?? RPO_BY_TIER[2] ?? 1440;
    const sla = SLA_BY_TIER[tierIndex] ?? SLA_BY_TIER[2] ?? 99.5;
    const criticality = tier === 1 ? 'mission_critical' : tier === 2 ? 'business_critical' : 'business_operational';
    const idx = b.ci(slot, 'business_service', { name }, name, { tier, users, revenuePerHour, currency: CURRENCY, owner: businessUnit, criticality, rtoMinutes: rto, rpoMinutes: rpo, slaTargetPercent: sla, applicationCount: chosen.length, channel: segment || 'all', healthModel: 'worst_of_dependencies' }, ryd.def.code, { tags: ['business-service', 'tier-' + String(tier)], primary: true });
    chosen.forEach((app, n) => {
      b.rel(slot, 'part_of_service', app.idx, idx, { role: n === 0 ? 'primary' : 'supporting' });
    });
    records.push({ name, tier, businessUnit, users, revenuePerHour, currency: CURRENCY, criticality, rtoMinutes: rto, rpoMinutes: rpo, slaTargetPercent: sla, applications: chosen.map((a) => a.name), identity: { name } });
  }
  return records;
}
