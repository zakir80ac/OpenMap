// REQ-DISC-029 — CIDR arithmetic for target expansion and exclusion, IPv4. Pure functions.
import { IPV4 } from '@openmap/constants';

const IPV4_BITS = IPV4.octets * IPV4.bitsPerOctet;
const RADIX = IPV4.octetMax + 1;

export function parseIpv4(address: string): number {
  const parts = address.split('.');
  if (parts.length !== IPV4.octets) throw new Error('invalid IPv4 address ' + address);
  let value = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > IPV4.octetMax) throw new Error('invalid IPv4 address ' + address);
    value = value * RADIX + n;
  }
  return value;
}

export function formatIpv4(value: number): string {
  const parts: number[] = [];
  let v = value;
  for (let i = 0; i < IPV4.octets; i++) {
    parts.unshift(v % RADIX);
    v = Math.floor(v / RADIX);
  }
  return parts.join('.');
}

export interface Cidr {
  base: number;
  prefix: number;
  size: number;
}

export function parseCidr(text: string): Cidr {
  const [addr, prefixText] = text.split('/');
  if (addr === undefined || prefixText === undefined) throw new Error('invalid CIDR ' + text);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > IPV4_BITS) throw new Error('invalid CIDR ' + text);
  const size = Math.pow(IPV4.binaryBase, IPV4_BITS - prefix);
  const base = Math.floor(parseIpv4(addr) / size) * size;
  return { base, prefix, size };
}

export function contains(cidr: Cidr, address: number): boolean {
  return address >= cidr.base && address < cidr.base + cidr.size;
}

/** Host addresses in a CIDR, excluding the network and broadcast addresses of blocks larger than a /31. */
export function* hosts(cidr: Cidr, excluded: readonly Cidr[]): Generator<number> {
  const skipEnds = cidr.size > IPV4.minSizeWithReservedEnds;
  const start = skipEnds ? cidr.base + 1 : cidr.base;
  const end = skipEnds ? cidr.base + cidr.size - 1 : cidr.base + cidr.size;
  for (let a = start; a < end; a++) {
    if (excluded.some((x) => contains(x, a))) continue;
    yield a;
  }
}
