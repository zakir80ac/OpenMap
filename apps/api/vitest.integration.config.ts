// REQ-CORE-012 — integration test configuration: runs against the compose stack (Postgres, Memgraph).
import { defineConfig } from 'vitest/config';
import { TIME } from '@openmap/constants';

const minuteMs = TIME.secondsPerMinute * TIME.msPerSecond;

export default defineConfig({
  test: { include: ['src/**/*.integration.test.ts'], testTimeout: minuteMs, hookTimeout: minuteMs, fileParallelism: false },
});
