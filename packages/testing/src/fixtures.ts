// REQ-QA-003 — fixture catalogue: recorded vendor outputs under packages/testing/fixtures and the
// generated synthetic estate. Recorded fixtures are captured from real devices (CLAUDE.md §8) and
// each carries a manifest naming the device, firmware and capture date; nothing here fabricates one.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '..', 'fixtures');

export interface FixtureManifest {
  family: string;
  vendor: string;
  model: string;
  firmware: string;
  capturedAt: string;
  capturedBy: string;
  files: string[];
  /** Redactions applied before check-in (serials, community strings, addresses). */
  redactions: string[];
}

export function listFixtureFamilies(): string[] {
  const vendorDir = join(FIXTURES_DIR, 'vendor');
  if (!existsSync(vendorDir)) return [];
  return readdirSync(vendorDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function readManifest(family: string, name: string): FixtureManifest {
  const path = join(FIXTURES_DIR, 'vendor', family, name, 'manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

export function fixturePath(...segments: string[]): string {
  return join(FIXTURES_DIR, ...segments);
}

/** Directory the synthetic estate generator writes to; present only after `synth-estate generate`. */
export function synthEstateDir(name = 'synth'): string {
  return join(FIXTURES_DIR, name);
}
