// REQ-SEC-011 — tests against the compose stack's OpenBao (export OPENBAO_TOKEN with an operator token).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.integration.test.ts'], testTimeout: 60_000 } });
