// T-584 REQ-INT-018 — deploy/appliance/openmap-firstboot.sh, run for real in the appliance's base OS (Ubuntu 24.04,
// in a container) against the repository's .env.example: every development default secret is replaced by its own
// random value, the host-side POSTGRES_URL carries the new password and keeps its TLS parameters, the public URLs
// name the appliance's address, the credentials file and .env are mode 0600, and a second run changes nothing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = mkdtempSync(join(tmpdir(), 'openmap-appliance-'));
const IMAGE = 'ubuntu:24.04';
const HOST = 'openmap.example.internal';

/** Runs the script in a fresh Ubuntu container with the work directory as the appliance's state. */
function firstboot(): string {
  const script = [
    'set -e',
    'mkdir -p /opt/openmap && cp /src/.env.example /opt/openmap/.env.example',
    '[ -f /work/env ] && cp /work/env /opt/openmap/.env || true',
    '[ -d /work/state ] && mkdir -p /var/lib/openmap && cp -R /work/state/. /var/lib/openmap/ || true',
    'OPENMAP_PUBLIC_HOST=' + HOST + ' OPENMAP_CREDENTIALS_FILE=/work/credentials.txt sh /src/openmap-firstboot.sh',
    'cp /opt/openmap/.env /work/env',
    'mkdir -p /work/state && cp -R /var/lib/openmap/. /work/state/',
    'stat -c "%a" /opt/openmap/.env > /work/env.mode',
    'stat -c "%a" /work/credentials.txt > /work/credentials.mode',
  ].join(' && ');
  return execFileSync(
    'docker',
    [
      'run', '--rm',
      '-v', join(repo, 'deploy/compose/.env.example') + ':/src/.env.example:ro',
      '-v', join(repo, 'deploy/appliance/openmap-firstboot.sh') + ':/src/openmap-firstboot.sh:ro',
      '-v', work + ':/work',
      IMAGE, 'sh', '-c', script,
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
}

function envOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (m?.[1] !== undefined) out.set(m[1], m[2] ?? '');
  }
  return out;
}

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('appliance first boot (integration)', () => {
  const example = envOf(readFileSync(join(repo, 'deploy/compose/.env.example'), 'utf8'));
  const SECRETS = ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'MEILI_MASTER_KEY', 'KEYCLOAK_ADMIN_PASSWORD', 'SUPERSET_SECRET_KEY', 'SUPERSET_ADMIN_PASSWORD', 'DNS_LAB_TSIG_SECRET'];
  let first = new Map<string, string>();

  it('replaces every default secret with its own random value and names the appliance', () => {
    expect(firstboot()).toContain('first boot done');
    first = envOf(readFileSync(join(work, 'env'), 'utf8'));
    const values = SECRETS.map((k) => first.get(k) ?? '');
    for (const [i, k] of SECRETS.entries()) {
      expect(values[i], k).toMatch(/^[A-Za-z0-9]{32}$/u);
      expect(values[i], k).not.toBe(example.get(k));
    }
    expect(new Set(values).size).toBe(SECRETS.length);
    const pg = first.get('POSTGRES_URL') ?? '';
    expect(pg).toContain(':' + (first.get('POSTGRES_PASSWORD') ?? '') + '@localhost:');
    expect(pg).toContain('sslmode=require');
    expect(pg).not.toContain(':openmap@');
    expect(first.get('PUBLIC_CONSOLE_URL')).toBe('http://' + HOST + ':3000');
    expect(first.get('PUBLIC_KEYCLOAK_URL')).toBe('http://' + HOST + ':8080');
    expect(first.get('SCHEDULER_TLS_EXTRA_SANS')).toBe(HOST);
    expect(readFileSync(join(work, 'env.mode'), 'utf8').trim()).toBe('600');
    expect(readFileSync(join(work, 'credentials.mode'), 'utf8').trim()).toBe('600');
    expect(readFileSync(join(work, 'credentials.txt'), 'utf8')).toContain(first.get('KEYCLOAK_ADMIN_PASSWORD') ?? '');
  });

  it('leaves the secrets of a running appliance alone on a second boot', () => {
    expect(firstboot()).toContain('first boot already done');
    expect(envOf(readFileSync(join(work, 'env'), 'utf8'))).toEqual(first);
  });
});
