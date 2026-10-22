// T-004 REQ-CORE-008
import { describe, expect, it } from 'vitest';
import { forbiddenTokens, literals, magicNumbers, reqHeader, runRules, unsafeTypes, userFacingStrings } from './rules.js';

const f = (path: string, text: string) => ({ path, text });

describe('guard rules', () => {
  it('flags forbidden tokens outside tests and constants', () => {
    expect(forbiddenTokens(f('apps/api/src/x.ts', '// TODO later'))).toHaveLength(1);
    expect(forbiddenTokens(f('apps/api/src/x.ts', 'const x = "coming  soon"'))).toHaveLength(1);
    expect(forbiddenTokens(f('packages/constants/src/index.ts', "'TODO'"))).toHaveLength(0);
    expect(runRules(f('apps/api/src/x.test.ts', '// TODO'))).toHaveLength(0);
  });
  it('flags any and unjustified disables', () => {
    expect(unsafeTypes(f('apps/api/src/x.ts', 'let a: any;'))).toHaveLength(1);
    expect(unsafeTypes(f('apps/api/src/x.ts', 'x as any'))).toHaveLength(1);
    expect(unsafeTypes(f('apps/api/src/x.ts', '// eslint-disable-next-line foo -- ADR-004'))).toHaveLength(0);
    expect(unsafeTypes(f('apps/api/src/x.ts', '// eslint-disable-next-line foo'))).toHaveLength(1);
  });
  it('flags literal addresses, urls, ports, secrets and paths except in config defaults', () => {
    expect(literals(f('apps/api/src/x.ts', "const h = '10.0.0.1'"))).toHaveLength(1);
    expect(literals(f('apps/api/src/x.ts', "fetch('http://example.com')"))).toHaveLength(1);
    expect(literals(f('apps/api/src/x.ts', 'const port = 4000'))).toHaveLength(1);
    expect(literals(f('apps/api/src/x.ts', "password: 'hunter22'"))).toHaveLength(1);
    expect(literals(f('apps/api/src/x.ts', "readFile('/etc/openmap/x')"))).toHaveLength(1);
    expect(literals(f('packages/config/src/env.ts', "default('http://localhost:8123')"))).toHaveLength(0);
  });
  it('flags magic numbers in apps only', () => {
    expect(magicNumbers(f('apps/api/src/x.ts', 'const n = 42;'))).toHaveLength(1);
    expect(magicNumbers(f('apps/api/src/x.ts', 'const n = 0 + 1 - -1;'))).toHaveLength(0);
    expect(magicNumbers(f('apps/api/src/x.ts', "const s = '42'"))).toHaveLength(0);
    expect(magicNumbers(f('packages/x/src/x.ts', 'const n = 42;'))).toHaveLength(0);
  });
  it('flags user-facing strings in console tsx', () => {
    expect(userFacingStrings(f('apps/console/app/page.tsx', '<h1>Dashboard</h1>'))).toHaveLength(1);
    expect(userFacingStrings(f('apps/console/app/page.tsx', "<h1>{t('nav.dashboard')}</h1>"))).toHaveLength(0);
    expect(userFacingStrings(f('apps/console/app/page.tsx', '<input placeholder="Search" />'))).toHaveLength(1);
  });
  it('requires a REQ id in app file headers', () => {
    expect(reqHeader(f('apps/api/src/x.ts', 'export const a = 1;'))).toHaveLength(1);
    expect(reqHeader(f('apps/api/src/x.ts', '// REQ-CORE-001\nexport const a = 1;'))).toHaveLength(0);
  });
});
