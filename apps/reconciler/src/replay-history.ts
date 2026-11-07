// REQ-BSM-008 REQ-QA-001 (ADR-024) — replays a synthetic health history (synth-estate `health-history`) through the
// real pipeline: every outage becomes two back-dated openmap.bsm.health.changed events in the outbox, which the
// dispatcher writes to ClickHouse (events and service_health_history), and one resolved incident with the response and
// resolution deadlines the service's SLA (or the defaults) would have set, acknowledged and resolved inside them.
// REQ-BSM-004 (ADR-047): each incident names a root cause, drawn deterministically (from the service name and the
// outage start) among the components, databases, VMs, hosts and hypervisors its applications depend on, so the API's
// impact validation has incidents to compare with a simulation of their root cause.
// Usage: pnpm --filter @openmap/reconciler replay-history --dir ../../packages/testing/fixtures/synth [--reset]
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from '@openmap/config';
import { CONTRACT_VERSIONS, ITSM, SLA, TIME } from '@openmap/constants';
import { eventEnvelopeSchema, type EventEnvelope } from '@openmap/contracts';
import { createPrismaClient, Prisma } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import {
  createClickHouse,
  createEventStream,
  createMeilisearchSink,
  dispatchOnce,
} from './worker/dispatcher.js';

const HISTORY_FILE = 'health-history.json';
const SUMMARY_FILE = 'estate-summary.json';
const SERVICE_TYPE = 'business_service';
const SOURCE = '/openmap/synth-estate';
const INCIDENT_SOURCE = 'bsm';
const HEALTH_CHANGED = 'openmap.bsm.health.changed';
const TIER_ATTRIBUTE = 'tier';
const SERVICE_EDGE = 'part_of_service';

/**
 * The failure points each service's applications depend on (downstream closure), sorted, per service id; a service
 * whose applications reach none falls back to the applications themselves.
 */
async function rootCauseCandidates(
  prisma: ReturnType<typeof createPrismaClient>,
  graph: ReturnType<typeof createGraphRepository>,
  tenantId: string,
  serviceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const edges = await prisma.relationship.findMany({
    where: { tenantId, type: SERVICE_EDGE, toCiId: { in: [...serviceIds] }, validTo: null },
    select: { fromCiId: true, toCiId: true },
  });
  const types = new Set<string>(SLA.synthetic.rootCauseTypes);
  const byApp = new Map<string, string[]>();
  for (const appId of new Set(edges.map((e) => e.fromCiId))) {
    const r = await graph.impact(tenantId, appId, { direction: 'downstream', maxDepth: 0, asOf: null, edgeTypes: [] });
    byApp.set(appId, r.nodes.filter((n) => types.has(n.ci.type)).map((n) => n.ci.id));
  }
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const reached = byApp.get(e.fromCiId) ?? [];
    const list = out.get(e.toCiId) ?? [];
    list.push(...(reached.length > 0 ? reached : [e.fromCiId]));
    out.set(e.toCiId, list);
  }
  for (const [id, list] of out) out.set(id, [...new Set(list)].sort());
  return out;
}

/** A deterministic pick: the same outage of the same service names the same root cause on every replay. */
function pick(candidates: readonly string[], key: string): string | null {
  if (candidates.length === 0) return null;
  const n = Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, SLA.synthetic.rootCausePickHexDigits), SLA.synthetic.rootCausePickRadix);
  return candidates[n % candidates.length] ?? null;
}

interface Outage {
  service: string;
  state: 'down' | 'degraded';
  startedAt: string;
  endedAt: string;
}

interface HistoryFile {
  seed: number;
  generatedAt: string;
  months: number;
  outages: Outage[];
}

interface Args {
  dir: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  let dir = '';
  let reset = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i] ?? '';
    if (argv[i] === '--reset') reset = true;
  }
  if (!dir) throw new Error('usage: replay-history --dir <path> [--reset]');
  return { dir: resolve(dir), reset };
}

function envelope(
  tenantId: string,
  subject: string,
  time: string,
  data: Record<string, unknown>,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    specversion: '1.0',
    id: randomUUID(),
    source: SOURCE,
    type: HEALTH_CHANGED,
    subject,
    time,
    datacontenttype: 'application/json',
    dataschema: 'openmap/contracts/event/' + CONTRACT_VERSIONS.event,
    tenantid: tenantId,
    data,
  });
}

function severityFor(tier: number, state: Outage['state']): 'critical' | 'high' | 'medium' {
  if (state === 'down' && tier === ITSM.priorityHighest) return 'critical';
  if (state === 'down' || tier === ITSM.priorityHighest) return 'high';
  return 'medium';
}

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  const args = parseArgs(argv);
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const history = JSON.parse(readFileSync(join(args.dir, HISTORY_FILE), 'utf8')) as HistoryFile;
  const tenantId = (JSON.parse(readFileSync(join(args.dir, SUMMARY_FILE), 'utf8')) as { tenantId: string })
    .tenantId;
  const graph = createGraphRepository(env);
  const sinks = {
    graph,
    clickhouse: createClickHouse(env),
    search: createMeilisearchSink(env),
    stream: createEventStream(env),
  };
  const services = await prisma.ci.findMany({
    where: { tenantId, type: SERVICE_TYPE, validTo: null },
    select: { id: true, name: true, displayName: true, attributes: true },
  });
  const byName = new Map(services.map((s) => [s.name, s]));
  const causes = await rootCauseCandidates(prisma, graph, tenantId, services.map((s) => s.id));
  const assignments = new Map(
    (await prisma.serviceSlaAssignment.findMany({ where: { tenantId }, include: { sla: true } })).map((a) => [
      a.serviceCiId,
      a.sla,
    ]),
  );

  if (args.reset) {
    const ids = services.map((s) => s.id);
    await prisma.incidentLink.deleteMany({
      where: { tenantId, incident: { source: INCIDENT_SOURCE, affectedServiceCiIds: { hasSome: ids } } },
    });
    const removed = await prisma.incident.deleteMany({
      where: { tenantId, source: INCIDENT_SOURCE, state: { in: ['resolved', 'closed'] } },
    });
    await prisma.outboxEvent.deleteMany({ where: { tenantId, type: HEALTH_CHANGED } });
    // The incidents' validations went with them; their replay scenarios and the open suggestions they made go too.
    await prisma.impactScenario.deleteMany({ where: { tenantId, origin: 'incident' } });
    await prisma.relationshipSuggestion.deleteMany({ where: { tenantId, state: 'open' } });
    for (const table of ['service_health_history']) {
      await sinks.clickhouse.command({
        query:
          'ALTER TABLE ' + env.CLICKHOUSE_DB + '.' + table + ' DELETE WHERE tenant_id = {tenantId:String}',
        query_params: { tenantId },
        clickhouse_settings: { mutations_sync: '2' },
      });
    }
    await sinks.clickhouse.command({
      query:
        'ALTER TABLE ' +
        env.CLICKHOUSE_DB +
        '.events DELETE WHERE tenant_id = {tenantId:String} AND type = {type:String}',
      query_params: { tenantId, type: HEALTH_CHANGED },
      clickhouse_settings: { mutations_sync: '2' },
    });
    console.log(JSON.stringify({ msg: 'reset', tenantId, incidentsRemoved: removed.count }));
  }

  let events = 0;
  let incidents = 0;
  let unknown = 0;
  const rows: Prisma.OutboxEventCreateManyInput[] = [];
  const incidentRows: Prisma.IncidentCreateManyInput[] = [];
  for (const o of history.outages) {
    const service = byName.get(o.service);
    if (!service) {
      unknown++;
      continue;
    }
    const rootCauseCiId = pick(causes.get(service.id) ?? [], o.service + '|' + o.startedAt);
    const open = envelope(tenantId, service.id, o.startedAt, {
      serviceId: service.id,
      state: o.state,
      previous: 'healthy',
      rootCauseIds: rootCauseCiId === null ? [] : [rootCauseCiId],
      groups: [],
      budgetRemainingMinutes: null,
    });
    const close = envelope(tenantId, service.id, o.endedAt, {
      serviceId: service.id,
      state: 'healthy',
      previous: o.state,
      rootCauseIds: [],
      groups: [],
      budgetRemainingMinutes: null,
    });
    for (const e of [open, close])
      rows.push({
        eventId: e.id,
        tenantId,
        type: e.type,
        subject: e.subject,
        envelope: e as unknown as Prisma.InputJsonValue,
        pending: ['clickhouse'],
      });
    events += SLA.synthetic.eventsPerOutage;
    const attrs = service.attributes as Record<string, unknown>;
    const tier =
      typeof attrs[TIER_ATTRIBUTE] === 'number' ? (attrs[TIER_ATTRIBUTE] as number) : ITSM.priorityMedium;
    const severity = severityFor(tier, o.state);
    const sla = assignments.get(service.id);
    const targets =
      (
        sla?.responseTargets as Partial<
          Record<string, { respondMinutes: number; resolveMinutes: number }>
        > | null
      )?.[severity] ?? SLA.defaultTargets[severity];
    const opened = Date.parse(o.startedAt);
    const ended = Date.parse(o.endedAt);
    const respondBy = opened + targets.respondMinutes * TIME.secondsPerMinute * TIME.msPerSecond;
    const resolveBy = opened + targets.resolveMinutes * TIME.secondsPerMinute * TIME.msPerSecond;
    const acknowledgedAt = Math.min(
      ended,
      opened +
        targets.respondMinutes * SLA.synthetic.acknowledgeShare * TIME.secondsPerMinute * TIME.msPerSecond,
    );
    incidentRows.push({
      tenantId,
      title: service.displayName + ' ' + o.state,
      description:
        service.displayName +
        ' was ' +
        o.state +
        ' for ' +
        String(Math.round((ended - opened) / (TIME.secondsPerMinute * TIME.msPerSecond))) +
        ' minutes.',
      severity,
      state: 'resolved',
      source: INCIDENT_SOURCE,
      affectedServiceCiIds: [service.id],
      rootCauseCiId,
      correlatedEventIds: [open.id],
      openedAt: new Date(opened),
      acknowledgedAt: new Date(acknowledgedAt),
      resolvedAt: new Date(ended),
      slaId: sla?.id ?? null,
      respondBy: new Date(respondBy),
      resolveBy: new Date(resolveBy),
      responseBreachedAt: acknowledgedAt > respondBy ? new Date(respondBy) : null,
      resolutionBreachedAt: ended > resolveBy ? new Date(resolveBy) : null,
    });
    incidents++;
  }
  await prisma.outboxEvent.createMany({ data: rows });
  await prisma.incident.createMany({ data: incidentRows });
  console.log(
    JSON.stringify({
      msg: 'queued',
      tenantId,
      services: services.length,
      outages: history.outages.length,
      events,
      incidents,
      unknownServices: unknown,
    }),
  );

  let delivered = 0;
  for (;;) {
    const r = await dispatchOnce(prisma, sinks, env.CLICKHOUSE_DB);
    if (r.failures.length) console.error(JSON.stringify({ msg: 'outbox failures', failures: r.failures }));
    delivered += r.delivered;
    if (r.claimed === 0 || (r.failures.length > 0 && r.delivered === 0)) break;
  }
  console.log(JSON.stringify({ msg: 'dispatched', delivered }));
  await sinks.stream.close();
  await sinks.clickhouse.close();
  await graph.close();
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
