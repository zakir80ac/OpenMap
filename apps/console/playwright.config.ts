// REQ-UI-003 — Playwright: one project per locale against the console at the configured public origin.
import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from '@openmap/config';

const env = loadEnv();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: env.PUBLIC_CONSOLE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'en', use: { ...devices['Desktop Chrome'], locale: 'en-GB' } },
    { name: 'ar', use: { ...devices['Desktop Chrome'], locale: 'ar' } },
  ],
  webServer: {
    command: 'pnpm start',
    url: env.PUBLIC_CONSOLE_URL,
    reuseExistingServer: true,
  },
});
