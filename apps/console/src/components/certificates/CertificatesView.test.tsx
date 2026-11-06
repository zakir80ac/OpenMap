// T-190 REQ-CMDB-032 (ADR-036) — Certificates in en and ar: headline counts over the whole inventory, the register with
// common names, SANs, days left or expired, weak key and signature tags, the endpoints secured and the issuer, the last
// alert raised; the horizon, weak and authority filters reach the query.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { CertificatesView, commonName, expiryState } from './CertificatesView';

const ci = (id: string, type: string, displayName: string) => ({ id, name: displayName, displayName, code: id.toUpperCase(), type, layer: 'network_security', health: 'healthy' });
const certificates = [
  {
    ci: ci('c1', 'certificate', 'portal.bank.example'),
    subject: 'CN=portal.bank.example, O=Bank',
    issuer: 'CN=Bank Issuing CA',
    notAfter: '2026-11-26T00:00:00.000Z',
    daysLeft: 20,
    expired: false,
    selfSigned: false,
    isCa: false,
    keyAlgorithm: 'RSA',
    keyBits: 1024,
    signatureAlgorithm: 'SHA1-RSA',
    weaknesses: ['short_key', 'weak_signature'],
    dnsNames: ['portal.bank.example', 'www.portal.bank.example'],
    endpoints: [{ listener: ci('l1', 'listening_service', 'tcp/443 tls'), host: 'web-01.bank.example', port: 443, serverName: 'portal.bank.example', tlsVersion: 'TLS 1.2' }],
    issuedBy: { id: 'ca1', displayName: 'Bank Issuing CA' },
    lastAlertDays: 30,
  },
  {
    ci: ci('c2', 'certificate', 'legacy.bank.example'),
    subject: 'CN=legacy.bank.example',
    issuer: 'CN=legacy.bank.example',
    notAfter: '2026-10-01T00:00:00.000Z',
    daysLeft: -36,
    expired: true,
    selfSigned: true,
    isCa: false,
    keyAlgorithm: 'ECDSA',
    keyBits: 256,
    signatureAlgorithm: 'ECDSA-SHA256',
    weaknesses: [],
    dnsNames: [],
    endpoints: [],
    issuedBy: null,
    lastAlertDays: 0,
  },
];

const calls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { variables?: { filter?: Record<string, unknown> } };
      const filter = body.variables?.filter ?? {};
      calls.push(filter);
      const list = certificates.filter((c) => (filter['weak'] === undefined || c.weaknesses.length > 0 === filter['weak']) && (filter['expiringWithinDays'] === undefined || (!c.expired && (c.daysLeft) <= Number(filter['expiringWithinDays']))));
      return Promise.resolve(new Response(JSON.stringify({ data: { certificates: list } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('certificate helpers', () => {
  it('reads common names and expiry states', () => {
    expect(commonName('CN=portal.bank.example, O=Bank')).toBe('portal.bank.example');
    expect(commonName('O=Bank, CN=api.bank.example')).toBe('api.bank.example');
    expect(commonName('O=Bank only')).toBe('O=Bank only');
    expect(expiryState({ daysLeft: -1, expired: true })).toBe('down');
    expect(expiryState({ daysLeft: 20, expired: false })).toBe('at_risk');
    expect(expiryState({ daysLeft: 45, expired: false })).toBe('degraded');
    expect(expiryState({ daysLeft: 200, expired: false })).toBe('healthy');
    expect(expiryState({ daysLeft: null, expired: false })).toBe('unknown');
  });
});

describe.each(LOCALES)('CertificatesView (%s)', (locale) => {
  it('shows the inventory with expiry, weaknesses, endpoints and issuer, and filters it', async () => {
    render(
      <Providers locale={locale}>
        <CertificatesView locale={locale} />
      </Providers>,
    );
    const register = await screen.findByTestId('certificate-register');
    const portal = register.querySelector('[data-certificate="portal.bank.example"]');
    if (!(portal instanceof HTMLElement)) throw new Error('portal row missing');
    expect(within(portal).getByText('portal.bank.example, www.portal.bank.example')).toBeTruthy();
    expect(within(portal).getByText(translate(locale, 'certificates.daysLeft', { days: '20' }))).toBeTruthy();
    expect(within(portal).getByText(translate(locale, 'certificates.weakness.short_key'))).toBeTruthy();
    expect(within(portal).getByText(translate(locale, 'certificates.weakness.weak_signature'))).toBeTruthy();
    expect(within(portal).getByText(translate(locale, 'certificates.alerted.days', { days: '30' }))).toBeTruthy();
    expect(within(portal).getByRole('link', { name: /web-01\.bank\.example:443/ })).toBeTruthy();
    expect(within(portal).getByRole('link', { name: 'Bank Issuing CA' })).toBeTruthy();
    const legacy = register.querySelector('[data-certificate="legacy.bank.example"]');
    if (!(legacy instanceof HTMLElement)) throw new Error('legacy row missing');
    expect(within(legacy).getByText(translate(locale, 'certificates.expiredAgo', { days: '36' }))).toBeTruthy();
    expect(within(legacy).getByText(translate(locale, 'certificates.tag.selfSigned'))).toBeTruthy();
    expect(within(legacy).getByText(translate(locale, 'certificates.alerted.expired'))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(translate(locale, 'certificates.filter.expiringWithin')), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(translate(locale, 'certificates.filter.weak')), { target: { value: 'yes' } });
    fireEvent.click(screen.getByLabelText(translate(locale, 'certificates.filter.authorities')));
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ expiringWithinDays: 30, weak: true, includeAuthorities: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId('certificate-register').querySelector('[data-certificate="legacy.bank.example"]')).toBeNull();
    });
  });
});
