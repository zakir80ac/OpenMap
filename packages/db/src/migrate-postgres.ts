// REQ-CORE-009 — applies prisma/migrations with `prisma migrate deploy`. The Prisma CLI reads
// POSTGRES_URL from the environment, so this runner supplies it from loadEnv() and the
// documented default from @openmap/config applies when the variable is unset.
import { spawnSync } from 'node:child_process';
import { loadEnv, type Env } from '@openmap/config';
import { PACKAGE_ROOT } from './files.js';

const PRISMA_ARGS = ['exec', 'prisma', 'migrate', 'deploy'];

export function migratePostgres(env: Env = loadEnv()): void {
  const win32 = process.platform === 'win32';
  const result = spawnSync(win32 ? 'pnpm.cmd' : 'pnpm', PRISMA_ARGS, {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    shell: win32,
    env: { ...process.env, POSTGRES_URL: env.POSTGRES_URL },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('prisma migrate deploy exited with status ' + String(result.status));
}
