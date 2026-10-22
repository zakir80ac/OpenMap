// REQ-UI-003 — Playwright: one project per locale against the console at the configured public origin.
import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from '@openmap/config';

const env = loadEnv();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // One worker: every spec signs in as the same seeded account, and the realm's brute-force policy treats concurrent
  // sign-ins within quickLoginCheckMilliSeconds as an attack and disables the user for a minute.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: env.PUBLIC_CONSOLE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /setup\.ts$/, use: { ...devices['Desktop Chrome'], locale: 'en-GB' } },
    { name: 'en', use: { ...devices['Desktop Chrome'], locale: 'en-GB' }, dependencies: ['setup'] },
    { name: 'ar', use: { ...devices['Desktop Chrome'], locale: 'ar' }, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'pnpm start',
    url: env.PUBLIC_CONSOLE_URL,
    reuseExistingServer: true,
  },
});
