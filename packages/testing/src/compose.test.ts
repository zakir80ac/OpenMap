// T-015 REQ-QA-002 REQ-QA-003
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_SERVICES, composePaths, listFixtureFamilies, FIXTURES_DIR } from './index.js';

describe('testing harness', () => {
  it('resolves the compose files from the repository root', () => {
    const p = composePaths();
    expect(existsSync(p.composeFile)).toBe(true);
    expect(existsSync(p.airgapFile)).toBe(true);
    expect(CORE_SERVICES).toContain('memgraph');
  });
  it('lists fixture families from the fixtures directory', () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    expect(Array.isArray(listFixtureFamilies())).toBe(true);
  });
});
