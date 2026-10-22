// REQ-UI-003 — runs `next dev` / `next start` on CONSOLE_PORT from validated config, so no port is written in a script.
import { spawnSync } from 'node:child_process';
import { loadEnv } from '@openmap/config';

const command = process.argv[process.argv.length - 1];
if (command !== 'dev' && command !== 'start') {
  console.error('usage: tsx scripts/next.ts <dev|start>');
  process.exit(1);
}

const env = loadEnv();
const result = spawnSync('next', [command, '--port', String(env.CONSOLE_PORT)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
