// REQ-IPAM-001 — IPAM use cases over subnet and ip_address CIs: the subnet tree by CIDR containment,
// utilisation from stored addresses, paginated addresses and the next free address.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BSM } from '@openmap/constants';
import type { RelationshipType } from '@openmap/contracts';
import { contains, parseCidr, type Cidr } from '@openmap/scheduler';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, Connection } from '../ci/ci.types.js';
import { clampPageSize, decodeCursor, encodeCursor } from '../common/cursor.js';
import { stringAttribute } from '../common/validation.js';
import { nextFreeIpv4, usableHosts } from './next-free-ip.js';

export const IN_SUBNET: RelationshipType = 'in_subnet';
/** VRF name the address plan's supernets are filed under when they belong to no routing instance. */
export const SHARED_VRF = 'global';

export interface SubnetView {
  ci: CiRecord;
  cidr: string;
  vrf: string | null;
  utilisationPercent: number;
  parentId: string | null;
}

interface ParsedSubnet {
  ci: CiRecord;
  cidr: string;
  block: Cidr;
  vrf: string | null;
}

@Injectable()
export class IpamService {
  constructor(@Inject(CI_REPOSITORY) private readonly cis: CiRepository) {}

  private async parsedSubnets(tenantId: string): Promise<ParsedSubnet[]> {
    const out: ParsedSubnet[] = [];
    for (const ci of await this.cis.byType(tenantId, 'subnet')) {
      // The contract identifies a subnet by (cidr, vrfRef); older collectors put them in attributes.
      const cidr = stringAttribute(ci.identity, 'cidr') ?? stringAttribute(ci.attributes, 'cidr');
      if (cidr === null) continue;
      try {
        out.push({ ci, cidr, block: parseCidr(cidr), vrf: stringAttribute(ci.identity, 'vrfRef') ?? stringAttribute(ci.attributes, 'vrf') });
      } catch {
        // A subnet CI whose cidr attribute is not IPv4 is left out of the IPv4 tree.
      }
    }
    return out;
  }

  /**
   * Parent is the smallest other subnet that contains this one in the same VRF; when the VRF has no such supernet,
   * the smallest containing subnet of the shared address plan (the `global` or unset VRF, where supernets live).
   */
  private static parentOf(s: ParsedSubnet, all: readonly ParsedSubnet[]): ParsedSubnet | null {
    const pick = (candidates: readonly ParsedSubnet[]): ParsedSubnet | null => {
      let best: ParsedSubnet | null = null;
      for (const other of candidates) {
        if (other.ci.id === s.ci.id) continue;
        if (other.block.size <= s.block.size || !contains(other.block, s.block.base)) continue;
        if (best === null || other.block.size < best.block.size) best = other;
      }
      return best;
    };
    return pick(all.filter((o) => o.vrf === s.vrf)) ?? pick(all.filter((o) => o.vrf === null || o.vrf === SHARED_VRF));
  }

  async subnets(tenantId: string, parentId: string | null): Promise<SubnetView[]> {
    const all = await this.parsedSubnets(tenantId);
    const chosen = all.filter((s) => (IpamService.parentOf(s, all)?.ci.id ?? null) === parentId);
    const counts = await this.addressCounts(tenantId, chosen.map((s) => s.ci.id));
    return chosen.map((s) => this.toView(s, IpamService.parentOf(s, all), counts.get(s.ci.id) ?? 0));
  }

  async subnet(tenantId: string, id: string): Promise<SubnetView> {
    const all = await this.parsedSubnets(tenantId);
    const s = all.find((x) => x.ci.id === id);
    if (!s) throw new NotFoundException('subnet ' + id + ' not found');
    const counts = await this.addressCounts(tenantId, [id]);
    return this.toView(s, IpamService.parentOf(s, all), counts.get(id) ?? 0);
  }

  private toView(s: ParsedSubnet, parent: ParsedSubnet | null, used: number): SubnetView {
    const usable = usableHosts(s.cidr);
    return { ci: s.ci, cidr: s.cidr, vrf: s.vrf, utilisationPercent: usable === 0 ? 0 : Math.min(BSM.percentScale, (used / usable) * BSM.percentScale), parentId: parent?.ci.id ?? null };
  }

  private async addressCounts(tenantId: string, subnetIds: readonly string[]): Promise<Map<string, number>> {
    const rels = await this.cis.relationshipsOfMany(tenantId, subnetIds, [IN_SUBNET], 'upstream');
    const counts = new Map<string, number>();
    for (const r of rels) counts.set(r.toCiId, (counts.get(r.toCiId) ?? 0) + 1);
    return counts;
  }

  async addressCis(tenantId: string, subnetId: string): Promise<CiRecord[]> {
    const rels = await this.cis.relationshipsOfMany(tenantId, [subnetId], [IN_SUBNET], 'upstream');
    const cis = await this.cis.findByIds(tenantId, rels.map((r) => r.fromCiId));
    return cis.filter((c) => c.type === 'ip_address').sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async addresses(tenantId: string, subnetId: string, first: number | null | undefined, after: string | null | undefined): Promise<Connection<CiRecord>> {
    const all = await this.addressCis(tenantId, subnetId);
    const size = clampPageSize(first);
    const cursor = after ? decodeCursor(after) : null;
    const start = cursor === null ? 0 : all.findIndex((c) => c.name > cursor.name || (c.name === cursor.name && c.id > cursor.id));
    const from = start < 0 ? all.length : start;
    const items = all.slice(from, from + size);
    const edges = items.map((node) => ({ cursor: encodeCursor({ name: node.name, id: node.id }), node }));
    const last = edges[edges.length - 1];
    return { edges, pageInfo: { endCursor: last ? last.cursor : null, hasNextPage: from + size < all.length }, totalCount: all.length };
  }

  async nextFreeIp(tenantId: string, subnetId: string): Promise<string | null> {
    const subnet = await this.subnet(tenantId, subnetId);
    const used = (await this.addressCis(tenantId, subnetId)).map((c) => stringAttribute(c.identity, 'address') ?? stringAttribute(c.attributes, 'address') ?? c.name);
    return nextFreeIpv4(subnet.cidr, used);
  }
}
