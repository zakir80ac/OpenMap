// REQ-PERF-005 (ADR-071) — platform health gauges the reconciler serves at scrape time. It is the one service that
// writes to every store, so it probes each of them (PostgreSQL, Memgraph, ClickHouse, Valkey, Meilisearch) and reports
// openmap_store_up and the probe time; it owns the outbox, so it reports how many rows wait and how old the oldest is;
// and it counts the jobs per state in both BullMQ queues (collector results in, the event stream out). One snapshot is
// taken per scrape and shared by the gauges; every probe has PLATFORM_HEALTH.storeProbeTimeoutMs, so a hung store marks
// itself down instead of stalling /metrics.
import type { Queue } from 'bullmq';
import { PLATFORM_HEALTH, TIME, type PlatformQueueState } from '@openmap/constants';
import type { PrismaClient } from '@openmap/db';
import { Gauge, withSpan, type Registry } from '@openmap/telemetry';

export type ProbedStore = (typeof PLATFORM_HEALTH.probedStores)[number];
export type StoreProbes = Record<ProbedStore, () => Promise<unknown>>;

export interface StoreState {
  store: ProbedStore;
  up: boolean;
  seconds: number;
}

export interface OutboxBacklog {
  pending: number;
  /** 0 when nothing waits. */
  oldestAgeSeconds: number;
}

export interface QueueDepth {
  queue: string;
  state: PlatformQueueState;
  jobs: number;
}

export interface PlatformSnapshot {
  stores: StoreState[];
  /** Null when PostgreSQL could not be read (its store probe says so). */
  backlog: OutboxBacklog | null;
  /** Empty when Valkey could not be read. */
  queues: QueueDepth[];
}

export class ProbeTimeout extends Error {
  constructor(what: string, ms: number) {
    super(what + ' did not answer within ' + String(ms) + ' ms');
    this.name = 'ProbeTimeout';
  }
}

/** Resolves with the work or rejects after `ms`; the timer never outlives the race. */
export async function withTimeout<T>(what: string, ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout(what, ms)), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeStores(probes: StoreProbes, timeoutMs: number = PLATFORM_HEALTH.storeProbeTimeoutMs): Promise<StoreState[]> {
  return Promise.all(
    PLATFORM_HEALTH.probedStores.map(async (store) => {
      const started = performance.now();
      let up = true;
      try {
        await withTimeout(store, timeoutMs, probes[store]);
      } catch {
        up = false;
      }
      return { store, up, seconds: (performance.now() - started) / TIME.msPerSecond };
    }),
  );
}

/** Undelivered outbox rows and the age of the oldest (the partial index on undelivered rows keeps this cheap). */
export async function readOutboxBacklog(prisma: PrismaClient, now: Date = new Date()): Promise<OutboxBacklog> {
  const rows = await prisma.$queryRaw<Array<{ pending: number; oldest: Date | null }>>`
    SELECT count(*)::int AS pending, min("createdAt") AS oldest FROM outbox_events WHERE "deliveredAt" IS NULL`;
  const row = rows[0];
  const oldest = row?.oldest ?? null;
  return {
    pending: row?.pending ?? 0,
    oldestAgeSeconds: oldest === null ? 0 : Math.max(0, (now.getTime() - oldest.getTime()) / TIME.msPerSecond),
  };
}

export async function readQueueDepths(queues: readonly Queue[]): Promise<QueueDepth[]> {
  const out: QueueDepth[] = [];
  for (const queue of queues) {
    const counts = await queue.getJobCounts(...PLATFORM_HEALTH.queueStates);
    for (const state of PLATFORM_HEALTH.queueStates) out.push({ queue: queue.name, state, jobs: counts[state] ?? 0 });
  }
  return out;
}

export interface PlatformGaugeSources {
  prisma: PrismaClient;
  probes: StoreProbes;
  queues: readonly Queue[];
  tracer: string;
  timeoutMs?: number;
}

export async function takePlatformSnapshot(sources: PlatformGaugeSources): Promise<PlatformSnapshot> {
  const ms = sources.timeoutMs ?? PLATFORM_HEALTH.storeProbeTimeoutMs;
  return withSpan(sources.tracer, 'platform.snapshot', {}, async (span) => {
    const [stores, backlog, queues] = await Promise.all([
      probeStores(sources.probes, ms),
      withTimeout('outbox backlog', ms, () => readOutboxBacklog(sources.prisma)).catch(() => null),
      withTimeout('queue depths', ms, () => readQueueDepths(sources.queues)).catch(() => [] as QueueDepth[]),
    ]);
    span.setAttribute('openmap.stores_down', stores.filter((s) => !s.up).length);
    span.setAttribute('openmap.outbox_pending', backlog?.pending ?? -1);
    return { stores, backlog, queues };
  });
}

/**
 * Registers the gauges on the reconciler's registry. prom-client collects every metric of a scrape concurrently, so the
 * gauges share one in-flight snapshot rather than probing the stores once per gauge.
 */
export function registerPlatformGauges(registry: Registry, sources: PlatformGaugeSources): { snapshot: () => Promise<PlatformSnapshot> } {
  let inflight: Promise<PlatformSnapshot> | null = null;
  const snapshot = (): Promise<PlatformSnapshot> => {
    if (inflight === null) {
      inflight = takePlatformSnapshot(sources).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
  const M = PLATFORM_HEALTH.metrics;
  new Gauge({
    name: M.storeUp,
    help: 'Whether the reconciler reached the store at scrape time (1 up, 0 down)',
    labelNames: ['store'],
    registers: [registry],
    async collect() {
      const s = await snapshot();
      this.reset();
      for (const st of s.stores) this.set({ store: st.store }, st.up ? 1 : 0);
    },
  });
  new Gauge({
    name: M.storeProbeSeconds,
    help: 'How long the scrape-time store probe took, in seconds (the probe timeout when the store did not answer)',
    labelNames: ['store'],
    registers: [registry],
    async collect() {
      const s = await snapshot();
      this.reset();
      for (const st of s.stores) this.set({ store: st.store }, st.seconds);
    },
  });
  new Gauge({
    name: M.outboxPending,
    help: 'Outbox rows not yet delivered to every target',
    registers: [registry],
    async collect() {
      const s = await snapshot();
      this.reset();
      if (s.backlog !== null) this.set(s.backlog.pending);
    },
  });
  new Gauge({
    name: M.outboxOldest,
    help: 'Age in seconds of the oldest undelivered outbox row (0 when none waits)',
    registers: [registry],
    async collect() {
      const s = await snapshot();
      this.reset();
      if (s.backlog !== null) this.set(s.backlog.oldestAgeSeconds);
    },
  });
  new Gauge({
    name: M.queueJobs,
    help: 'BullMQ jobs per queue and state',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      const s = await snapshot();
      this.reset();
      for (const q of s.queues) this.set({ queue: q.queue, state: q.state }, q.jobs);
    },
  });
  return { snapshot };
}
