// T-514 REQ-IPAM-003 — DNS change validation and settlement: A and AAAA values must be addresses of their family,
// names must be DNS names; a record name resolves within its zone; an added record is applied when the transfer holds
// it and a deleted one when it does not, comparing names and values as the transfer reports them.
import { describe, expect, it } from 'vitest';
import { dnsChangeInputSchema, dnsNameIn, settleDnsChange } from './dns-sync.js';

const change = { zone: 'lab.example', op: 'add', name: 'api', recordType: 'A', value: '10.9.0.81', ttl: 600 } as const;

describe('dns changes', () => {
  it('validates values by record type', () => {
    expect(dnsChangeInputSchema.safeParse(change).success).toBe(true);
    expect(dnsChangeInputSchema.safeParse({ ...change, value: 'not-an-ip' }).success).toBe(false);
    expect(dnsChangeInputSchema.safeParse({ ...change, recordType: 'AAAA', value: '10.9.0.81' }).success).toBe(false);
    expect(dnsChangeInputSchema.safeParse({ ...change, recordType: 'AAAA', value: '2001:db8::81' }).success).toBe(true);
    expect(dnsChangeInputSchema.safeParse({ ...change, recordType: 'CNAME', value: 'www.lab.example.' }).success).toBe(true);
    expect(dnsChangeInputSchema.safeParse({ ...change, name: 'bad name!' }).success).toBe(false);
  });

  it('resolves names within the zone', () => {
    expect(dnsNameIn('api', 'lab.example')).toBe('api.lab.example');
    expect(dnsNameIn('API.lab.example.', 'lab.example')).toBe('api.lab.example');
    expect(dnsNameIn('@', 'lab.example.')).toBe('lab.example');
  });

  it('settles a change from the transfer that follows it', () => {
    const transfer = [
      { name: 'api.lab.example', recordType: 'A', value: '10.9.0.81' },
      { name: 'web.lab.example', recordType: 'CNAME', value: 'api.lab.example.' },
    ];
    expect(settleDnsChange(transfer, change)).toBe('applied');
    expect(settleDnsChange(transfer, { ...change, value: '10.9.0.99' })).toBe('failed');
    expect(settleDnsChange(transfer, { ...change, op: 'delete', name: 'www' })).toBe('applied');
    expect(settleDnsChange(transfer, { ...change, op: 'delete' })).toBe('failed');
    expect(settleDnsChange(transfer, { ...change, name: 'web', recordType: 'CNAME', value: 'API.lab.example' })).toBe('applied');
  });
});
