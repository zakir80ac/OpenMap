// REQ-CORE-013 REQ-DISC-028 — hands accepted collector results to the reconciler over BullMQ (Valkey).
// The payload is the result as validated; the reconciler worker consumes it and writes through the outbox.
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { DISCOVERY, RECONCILER } from '@openmap/constants';
import type { CollectorResult } from '@openmap/contracts';
import type { Env } from '@openmap/config';

export const RESULTS_QUEUE = RECONCILER.resultsQueue;

export interface ResultsQueue {
  publish(result: CollectorResult): Promise<string>;
  close(): Promise<void>;
}

export function createResultsQueue(env: Pick<Env, 'VALKEY_URL'>): ResultsQueue {
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue<CollectorResult>(RESULTS_QUEUE, { connection });
  const options: JobsOptions = {
    attempts: DISCOVERY.retryBackoffMs.length,
    backoff: { type: 'exponential', delay: DISCOVERY.retryBackoffMs[0] },
    removeOnComplete: { count: DISCOVERY.targetsPerJob },
    removeOnFail: false,
  };
  return {
    async publish(result) {
      const job = await queue.add(result.collectorId, result, { ...options, jobId: result.runId });
      return job.id ?? result.runId;
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
