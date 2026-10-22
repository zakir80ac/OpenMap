// T-016 REQ-IPAM-001 — next free IPv4 address arithmetic.
import { describe, expect, it } from 'vitest';
import { nextFreeIpv4, usableHosts } from './next-free-ip.js';

describe('nextFreeIpv4', () => {
  it('skips the network address and returns the first host when nothing is used', () => {
    expect(nextFreeIpv4('10.42.0.0/29', [])).toBe('10.42.0.1');
  });
  it('returns the lowest unused host address', () => {
    expect(nextFreeIpv4('10.42.0.0/29', ['10.42.0.1', '10.42.0.2'])).toBe('10.42.0.3');
    expect(nextFreeIpv4('10.42.0.0/29', ['10.42.0.2'])).toBe('10.42.0.1');
  });
  it('never hands out the broadcast address and reports a full subnet as null', () => {
    expect(nextFreeIpv4('10.42.0.0/30', ['10.42.0.1'])).toBe('10.42.0.2');
    expect(nextFreeIpv4('10.42.0.0/30', ['10.42.0.1', '10.42.0.2'])).toBeNull();
  });
  it('treats /31 point-to-point blocks as two usable hosts', () => {
    expect(nextFreeIpv4('192.168.1.0/31', [])).toBe('192.168.1.0');
    expect(nextFreeIpv4('192.168.1.0/31', ['192.168.1.0'])).toBe('192.168.1.1');
    expect(nextFreeIpv4('192.168.1.0/31', ['192.168.1.0', '192.168.1.1'])).toBeNull();
  });
  it('normalises a non-aligned CIDR to its network and ignores malformed or IPv6 used addresses', () => {
    expect(nextFreeIpv4('10.42.0.5/29', ['fd00::1', 'not-an-ip', '10.42.0.1'])).toBe('10.42.0.2');
  });
  it('rejects invalid CIDRs', () => {
    expect(() => nextFreeIpv4('10.42.0.0', [])).toThrow();
    expect(() => nextFreeIpv4('10.42.0.0/33', [])).toThrow();
  });
});

describe('usableHosts', () => {
  it('counts hosts excluding network and broadcast for blocks larger than /31', () => {
    expect(usableHosts('10.0.0.0/24')).toBe(254);
    expect(usableHosts('10.0.0.0/30')).toBe(2);
    expect(usableHosts('10.0.0.0/31')).toBe(2);
    expect(usableHosts('10.0.0.0/32')).toBe(1);
  });
});
