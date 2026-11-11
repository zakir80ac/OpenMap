// REQ-UI-003 — Vitest: jsdom for component tests, automatic JSX runtime, the @/ alias used by the app.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TIME } from '@openmap/constants';

// The heaviest screen tests (the asset register's plans and receipts) take over the 5 s default on a CI runner.
const minuteMs = TIME.secondsPerMinute * TIME.msPerSecond;

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: minuteMs,
  },
});
