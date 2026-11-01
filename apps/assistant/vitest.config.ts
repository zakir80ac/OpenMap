// REQ-AI-001 — unit test configuration; the golden set runs through vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts', 'node_modules/**', 'dist/**'] },
});
