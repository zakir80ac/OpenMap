// REQ-QA-001 — IPv4 helpers. Addresses are always built from numeric octets at run time so the
// estate stays inside RFC 1918 space and no dotted literal appears in source.

export const RFC1918_TEN = 10;
export const OCTET_MAX = 255;

export function ip4(a: number, b: number, c: number, d: number): string {
  for (const o of [a, b, c, d]) if (o < 0 || o > OCTET_MAX || !Number.isInteger(o)) throw new Error('octet out of range: ' + String(o));
  return [a, b, c, d].join('.');
}

export function cidr(a: number, b: number, c: number, d: number, prefix: number): string {
  return ip4(a, b, c, d) + '/' + String(prefix);
}

/** Host count usable inside a /24 after reserving .0–.9 for gateways, HSRP/VRRP and network services. */
export const SLASH24_RESERVED = 10;
export const SLASH24_USABLE = 256 - SLASH24_RESERVED - 2;

/** Place the n-th endpoint of a pool into consecutive /24s of a /16 starting at second octet `b`. */
export function poolAddress(b: number, n: number): { address: string; subnetIndex: number; subnetCidr: string; gateway: string } {
  const subnetIndex = Math.floor(n / SLASH24_USABLE);
  const hostOffset = SLASH24_RESERVED + (n % SLASH24_USABLE);
  const c = subnetIndex & OCTET_MAX;
  const bOffset = b + (subnetIndex >> 8);
  return {
    address: ip4(RFC1918_TEN, bOffset, c, hostOffset),
    subnetIndex,
    subnetCidr: cidr(RFC1918_TEN, bOffset, c, 0, 24),
    gateway: ip4(RFC1918_TEN, bOffset, c, 1),
  };
}

/** n-th /31 point-to-point link inside the /16 at second octet `b`; returns both ends. */
export function linkPair(b: number, n: number): { cidr: string; a: string; z: string } {
  const c = (n >> 7) & OCTET_MAX;
  const d = (n & 0x7f) * 2;
  return { cidr: cidr(RFC1918_TEN, b, c, d, 31), a: ip4(RFC1918_TEN, b, c, d), z: ip4(RFC1918_TEN, b, c, d + 1) };
}
