// REQ-QA-002 — compose test harness: starts the real stack for integration tests, waits for health,
// and tears down only what it started. Paths are resolved from the repository root, never literal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..');
const COMPOSE_DIR = join(REPO_ROOT, 'deploy', 'compose');
const COMPOSE_FILE = join(COMPOSE_DIR, 'docker-compose.yml');
const AIRGAP_FILE = join(COMPOSE_DIR, 'docker-compose.airgap.yml');

export const CORE_SERVICES = ['postgres', 'memgraph', 'clickhouse', 'valkey', 'meilisearch', 'openbao'] as const;
export type ComposeService = (typeof CORE_SERVICES)[number] | 'keycloak' | 'superset' | 'otel-collector' | 'prometheus' | 'llm-cpu' | 'llm-gpu';

export interface ComposeOptions {
  services: readonly ComposeService[];
  airgap: boolean;
  /** Milliseconds to wait for health checks. */
  timeoutMs: number;
}

function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { cwd: COMPOSE_DIR, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('docker ' + args.join(' ') + ' timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function composeArgs(airgap: boolean): string[] {
  const args = ['compose', '-f', COMPOSE_FILE];
  if (airgap) args.push('-f', AIRGAP_FILE);
  return args;
}

export interface Harness {
  /** Services this harness started (already-running ones are left alone on teardown). */
  started: ComposeService[];
  down(): Promise<void>;
}

export async function runningServices(airgap = false): Promise<Set<string>> {
  const r = await run([...composeArgs(airgap), 'ps', '--services', '--status', 'running'], 60_000);
  return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

/** Starts the requested services and waits for their health checks; idempotent for running services. */
export async function up(options: ComposeOptions): Promise<Harness> {
  if (!existsSync(COMPOSE_FILE)) throw new Error('compose file not found at ' + COMPOSE_FILE);
  const already = await runningServices(options.airgap);
  const toStart = options.services.filter((s) => !already.has(s));
  if (toStart.length > 0) {
    const r = await run([...composeArgs(options.airgap), 'up', '-d', '--wait', ...toStart], options.timeoutMs);
    if (r.code !== 0) throw new Error('compose up failed: ' + r.stderr);
  }
  return {
    started: toStart,
    async down() {
      if (toStart.length === 0) return;
      await run([...composeArgs(options.airgap), 'stop', ...toStart], options.timeoutMs);
    },
  };
}

export function composePaths(): { repoRoot: string; composeDir: string; composeFile: string; airgapFile: string } {
  return { repoRoot: REPO_ROOT, composeDir: COMPOSE_DIR, composeFile: COMPOSE_FILE, airgapFile: AIRGAP_FILE };
}
