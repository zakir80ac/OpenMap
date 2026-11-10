// REQ-SEC-011 — unit tests only; the *.integration.test.ts files run against the compose stack (vitest.integration.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'] },
});
