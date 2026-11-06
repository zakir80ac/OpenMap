// REQ-BSM-001 REQ-CMDB-032 — vitest configuration for tests against the compose stack.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.integration.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
