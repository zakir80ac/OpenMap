// T-585 REQ-SEC-011 (ADR-068) — trustServiceCa adds the internal services CA to the default CA set: every certificate of
// the bundle, after the ones already trusted, once per path; nothing when unset; an error for a file with no certificate.
import { describe, expect, it } from 'vitest';
import { pemCertificates, trustServiceCa, type CaTrust } from './service-ca.js';

const pem = (body: string) => '-----BEGIN CERTIFICATE-----\n' + body + '\n-----END CERTIFICATE-----';
const ROOT = pem('cm9vdA==');
const BOOT = pem('Ym9vdA==');
const SYSTEM = pem('c3lzdGVt');

function fakeTrust(files: Record<string, string>): CaTrust & { current: string[]; sets: number } {
  const state = {
    current: [SYSTEM],
    sets: 0,
    read: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT ' + path);
      return text;
    },
    defaults: () => [...state.current],
    setDefaults: (certs: string[]) => {
      state.current = certs;
      state.sets += 1;
    },
  };
  return state;
}

describe('trustServiceCa', () => {
  it('splits a bundle into its certificates', () => {
    expect(pemCertificates(ROOT + '\n' + BOOT + '\n')).toEqual([ROOT, BOOT]);
    expect(pemCertificates('not a certificate')).toEqual([]);
  });

  it('adds every certificate of the bundle after the trusted ones, once per path', () => {
    const trust = fakeTrust({ '/ca/a.crt': ROOT + '\n' + BOOT + '\n' });
    expect(trustServiceCa('/ca/a.crt', trust)).toBe(2);
    expect(trust.current).toEqual([SYSTEM, ROOT, BOOT]);
    expect(trustServiceCa('/ca/a.crt', trust)).toBe(0);
    expect(trust.sets).toBe(1);
  });

  it('does not add a certificate that is already trusted', () => {
    const trust = fakeTrust({ '/ca/b.crt': SYSTEM + '\n' + ROOT });
    expect(trustServiceCa('/ca/b.crt', trust)).toBe(1);
    expect(trust.current).toEqual([SYSTEM, ROOT]);
  });

  it('does nothing without a path', () => {
    const trust = fakeTrust({});
    expect(trustServiceCa(undefined, trust)).toBe(0);
    expect(trust.sets).toBe(0);
  });

  it('refuses a file that holds no certificate', () => {
    const trust = fakeTrust({ '/ca/empty.crt': '' });
    expect(() => trustServiceCa('/ca/empty.crt', trust)).toThrow(/names no PEM certificate/u);
    expect(trust.sets).toBe(0);
  });
});
