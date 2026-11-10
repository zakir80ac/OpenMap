// REQ-INT-018 — the appliance's first-boot script, run for real inside an Ubuntu container (needs Docker).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.integration.test.ts'], testTimeout: 300_000, hookTimeout: 300_000 },
});
