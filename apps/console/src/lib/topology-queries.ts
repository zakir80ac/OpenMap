// REQ-DEP-001 (ADR-030) — network topology maps for the Dependencies screen: L2 (LLDP/CDP neighbour links, with host
// cabling on request) and L3 (devices to the subnets of their addresses), optionally for one site.
import { queryOptions } from '@tanstack/react-query';
import type { TOPOLOGY } from '@openmap/constants';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export type TopologyLayer = (typeof TOPOLOGY.layers)[number];
export type TopologyLinkKind = 'neighbour' | 'host' | 'subnet';

export interface TopologyLink {
  id: string;
  from: CiSummary;
  to: CiSummary;
  kind: TopologyLinkKind;
  count: number;
  ports: string[];
  protocols: string[];
  media: string[];
  speedMbps: number | null;
}

export interface NetworkTopology {
  layer: TopologyLayer;
  nodes: Array<{ degree: number; ci: CiSummary }>;
  links: TopologyLink[];
  truncated: boolean;
  durationMs: number;
}

export interface TopologyInput {
  layer: TopologyLayer;
  siteId: string | null;
  includeHosts: boolean;
}

const TOPOLOGY_QUERY =
  'query NetworkTopology($layer: TopologyLayer, $siteId: UUID, $includeHosts: Boolean) { networkTopology(layer: $layer, siteId: $siteId, includeHosts: $includeHosts) { layer truncated durationMs nodes { degree ci { ' +
  CI_SUMMARY_FIELDS +
  ' } } links { id kind count ports protocols media speedMbps from { ' +
  CI_SUMMARY_FIELDS +
  ' } to { ' +
  CI_SUMMARY_FIELDS +
  ' } } } }';

export function topologyQuery(input: TopologyInput) {
  return queryOptions({
    queryKey: ['network-topology', input] as const,
    queryFn: ({ signal }) =>
      gql<{ networkTopology: NetworkTopology }>(TOPOLOGY_QUERY, { ...input }, signal).then((d) => d.networkTopology),
  });
}
