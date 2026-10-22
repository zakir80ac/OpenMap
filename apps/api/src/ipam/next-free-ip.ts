// REQ-IPAM-001 — next free address in a subnet: the lowest host address of the CIDR that no stored
// ip_address CI occupies. Pure IPv4 arithmetic shared with the scheduler's CIDR helpers.
import { formatIpv4, hosts, parseCidr, parseIpv4 } from '@openmap/scheduler';

export function nextFreeIpv4(cidr: string, used: readonly string[]): string | null {
  const block = parseCidr(cidr);
  const taken = new Set<number>();
  for (const address of used) {
    try {
      taken.add(parseIpv4(address));
    } catch {
      // Addresses that are not IPv4 (IPv6 or malformed) cannot occupy an IPv4 slot.
    }
  }
  for (const candidate of hosts(block, [])) if (!taken.has(candidate)) return formatIpv4(candidate);
  return null;
}

/** Host addresses available in a CIDR (network and broadcast excluded for blocks larger than a /31). */
export function usableHosts(cidr: string): number {
  let n = 0;
  for (const _ of hosts(parseCidr(cidr), [])) n++;
  return n;
}
