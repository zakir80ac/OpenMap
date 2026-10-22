// T-011 REQ-CORE-009 — the generated init migration creates every table and enum in the schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './files.js';
import { listPostgresMigrations } from './migrate-postgres.js';

const prismaDir = join(PACKAGE_ROOT, 'prisma');
const schema = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
const migration = readFileSync(join(prismaDir, 'migrations', '0001_init', 'migration.sql'), 'utf8');
/** Every migration in order: later migrations add models and indexes the init migration predates. */
const allMigrations = listPostgresMigrations().map((m) => m.sql).join('\n');
const lock = readFileSync(join(prismaDir, 'migrations', 'migration_lock.toml'), 'utf8');

function mappedTables(): string[] {
  return [...schema.matchAll(/^model \w+ \{[\s\S]*?^\}/gm)].map((m) => {
    const map = /@@map\("([a-z_]+)"\)/.exec(m[0]);
    if (!map) throw new Error('model without @@map: ' + m[0].slice(0, 40));
    return map[1] ?? '';
  });
}

function enumNames(): string[] {
  return [...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1] ?? '');
}

describe('prisma/migrations/0001_init', () => {
  it('carries the REQ header and a postgresql lock file', () => {
    expect(migration.startsWith('-- REQ-CORE-009')).toBe(true);
    expect(lock).toMatch(/provider = "postgresql"/);
  });

  it('creates a table for every model', () => {
    const tables = mappedTables();
    expect(tables.length).toBeGreaterThanOrEqual(34);
    for (const t of tables) expect(allMigrations).toContain('CREATE TABLE "' + t + '" (');
    expect((allMigrations.match(/CREATE TABLE "/g) ?? []).length).toBe(tables.length);
  });

  it('creates a type for every enum', () => {
    const enums = enumNames();
    for (const e of enums) expect(allMigrations).toContain('CREATE TYPE "' + e + '" AS ENUM (');
    expect((allMigrations.match(/CREATE TYPE "/g) ?? []).length).toBe(enums.length);
  });

  it('creates the bitemporal and GIN indexes and the outbox bigserial', () => {
    expect(migration).toMatch(/CREATE INDEX "cis_tenantId_validTo_idx" ON "cis"\("tenantId", "validTo"\)/);
    expect(migration).toMatch(/CREATE INDEX "cis_attributes_idx" ON "cis" USING GIN \("attributes" jsonb_path_ops\)/);
    expect(migration).toMatch(/CREATE INDEX "relationships_fromCiId_idx"/);
    expect(migration).toMatch(/CREATE INDEX "relationships_toCiId_idx"/);
    expect(migration).toMatch(/"sequence" BIGSERIAL NOT NULL/);
    expect(migration).toMatch(/CREATE INDEX "outbox_events_deliveredAt_idx" ON "outbox_events"\("deliveredAt"\)/);
  });

  it('adds a foreign key from every tenant-scoped table to tenants', () => {
    const fkTargets = [...migration.matchAll(/ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "\w+" FOREIGN KEY \("tenantId"\) REFERENCES "tenants"/g)].map((m) => m[1]);
    expect(new Set(fkTargets).size).toBeGreaterThanOrEqual(26);
    expect(fkTargets).toContain('cis');
    expect(fkTargets).toContain('relationships');
    expect(fkTargets).toContain('outbox_events');
  });
});
