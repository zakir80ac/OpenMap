// REQ-AI-001 — unit test configuration; the golden set runs through vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';
import { TIME } from '@openmap/constants';

// The classification test walks the whole evaluation set: 0.7 s on a dev host, past vitest's 5 s default on a shared
// CI runner. A minute, as the console's suite allows.
const minuteMs = TIME.secondsPerMinute * TIME.msPerSecond;

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts', 'node_modules/**', 'dist/**'], testTimeout: minuteMs },
});
