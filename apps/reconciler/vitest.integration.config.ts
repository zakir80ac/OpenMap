// REQ-CORE-013 — vitest configuration for tests against the compose stack.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // One file at a time: the platform gauges read the whole outbox backlog, which the dispatch suite fills with thousands
  // of rows of its own tenant while it runs.
  test: { include: ['src/**/*.integration.test.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
