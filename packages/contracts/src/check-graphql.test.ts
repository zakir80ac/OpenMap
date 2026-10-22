// T-092 REQ-CORE-006 — the GraphQL contract check: header version must match the constant, comment-only changes
// pass, additions need a minor bump, removals need a major bump, and the committed schema is read from git.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { committedSchema, compareSchemas, schemaVersion } from './check-graphql.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'graphql', 'schema.graphql');

const base = `# OpenMap GraphQL contract, version 1.2.0
type Query { ci(id: ID!): Ci }
type Ci { id: ID! name: String! }
`;

describe('GraphQL contract check', () => {
  it('reads the version from the header and requires it to match the constant', () => {
    expect(schemaVersion(base)).toBe('1.2.0');
    const headerOnly = base.replace('1.2.0', '1.3.0');
    const verdict = compareSchemas(base, headerOnly, '1.2.0');
    expect(verdict.ok).toBe(false);
    expect(verdict.messages[0]).toContain('CONTRACT_VERSIONS.graphql');
  });

  it('accepts comment and formatting changes without a bump', () => {
    const reformatted = base + '\n# trailing note\n';
    expect(compareSchemas(base, reformatted, '1.2.0')).toEqual({ ok: true, messages: [] });
  });

  it('requires a minor bump for an addition and a major bump for a removal', () => {
    const added = base.replace('name: String! }', 'name: String! code: String }');
    expect(compareSchemas(base, added, '1.2.0').ok).toBe(false);
    expect(compareSchemas(base, added.replace('1.2.0', '1.3.0'), '1.3.0')).toEqual({ ok: true, messages: [] });

    const removed = base.replace(' name: String!', '');
    const minorOnly = compareSchemas(base, removed.replace('1.2.0', '1.3.0'), '1.3.0');
    expect(minorOnly.ok).toBe(false);
    expect(minorOnly.messages.some((m) => m.startsWith('breaking: '))).toBe(true);
    const major = compareSchemas(base, removed.replace('1.2.0', '2.0.0'), '2.0.0');
    expect(major.ok).toBe(true);
    expect(major.messages).toHaveLength(1);
  });

  it('the committed schema passes against its own history and its header matches the constant', () => {
    const working = readFileSync(schemaPath, 'utf8');
    expect(schemaVersion(working)).toBe(CONTRACT_VERSIONS.graphql);
    const repoRoot = join(here, '..', '..', '..');
    const previous = committedSchema(repoRoot, schemaPath, 'HEAD', working);
    if (previous !== null) expect(compareSchemas(previous, working, CONTRACT_VERSIONS.graphql).ok).toBe(true);
  });
});
