// REQ-AI-001 — golden-set configuration: runs against the compose stack (Memgraph and the LLM profile).
import { defineConfig } from 'vitest/config';
import { TIME } from '@openmap/constants';

const minuteMs = TIME.secondsPerMinute * TIME.msPerSecond;

export default defineConfig({
  test: { include: ['src/**/*.integration.test.ts'], testTimeout: minuteMs, hookTimeout: minuteMs, fileParallelism: false },
});
