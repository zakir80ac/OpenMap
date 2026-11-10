// REQ-IPAM-005 (ADR-064) — firewall rules and policy objects as the IPAM "Firewall" tab reads them: devices with
// rules, a device's policy with its analysis, and a traffic check across firewalls.
import { queryOptions } from '@tanstack/react-query';
import type {
  FirewallAction,
  FirewallFindingKind,
  FirewallObjectKind,
  FirewallVerdict,
} from '@openmap/contracts';
import { gql } from './graphql';

export interface FirewallCi {
  id: string;
  name: string;
  displayName: string;
  type: string;
}

export interface FirewallFinding {
  kind: FirewallFindingKind;
  byRuleId: string | null;
  byName: string | null;
  sameAction: boolean | null;
}

export interface FirewallRule {
  rule: FirewallCi;
  ruleId: string;
  name: string;
  chain: string;
  hook: string | null;
  position: number;
  action: FirewallAction;
  target: string | null;
  sources: string[];
  destinations: string[];
  services: string[];
  fromZone: string | null;
  toZone: string | null;
  inInterface: string | null;
  outInterface: string | null;
  conditions: string[];
  hitCount: number | null;
  logging: boolean;
  enabled: boolean;
  comment: string | null;
  isPolicy: boolean;
  findings: FirewallFinding[];
}

export interface FirewallObject {
  object: FirewallCi;
  objectId: string;
  name: string;
  kind: FirewallObjectKind;
  elements: string[];
  comment: string | null;
  ruleCount: number;
  unused: boolean;
}

export interface FirewallChain {
  name: string;
  hook: string | null;
  chainType: string | null;
  rules: number;
  policy: FirewallAction | null;
}

export interface FirewallPolicy {
  device: FirewallCi;
  summary: {
    rules: number;
    allow: number;
    deny: number;
    nat: number;
    objects: number;
    shadowed: number;
    unused: number;
    permissive: number;
    unusedObjects: number;
  };
  chains: FirewallChain[];
  rules: FirewallRule[];
  objects: FirewallObject[];
  truncated: boolean;
}

export interface FirewallDevice {
  device: FirewallCi;
  rules: number;
  objects: number;
}

export interface FirewallCheckInput {
  source: string;
  destination: string;
  protocol: string;
  port: number | null;
  deviceId: string | null;
  fromZone: string | null;
  toZone: string | null;
}

export interface FirewallCheckResult {
  device: FirewallCi;
  chain: string;
  verdict: FirewallVerdict;
  rule: Pick<FirewallRule, 'ruleId' | 'name' | 'position' | 'chain' | 'action' | 'isPolicy'> | null;
  path: string[];
  uncertain: Array<Pick<FirewallRule, 'ruleId' | 'name' | 'position'>>;
}

export interface FirewallCheck {
  evaluated: number;
  truncated: boolean;
  results: FirewallCheckResult[];
}

const CI = 'id name displayName type';
const RULE =
  'rule { ' +
  CI +
  ' } ruleId name chain hook position action target sources destinations services fromZone toZone inInterface outInterface conditions hitCount logging enabled comment isPolicy findings { kind byRuleId byName sameAction }';
const DEVICES_QUERY =
  'query FirewallDevices($text: String) { firewallDevices(text: $text) { device { ' +
  CI +
  ' } rules objects } }';
const POLICY_QUERY =
  'query FirewallPolicy($deviceId: UUID!) { firewallPolicy(deviceId: $deviceId) { device { ' +
  CI +
  ' } summary { rules allow deny nat objects shadowed unused permissive unusedObjects } chains { name hook chainType rules policy } rules { ' +
  RULE +
  ' } objects { object { ' +
  CI +
  ' } objectId name kind elements comment ruleCount unused } truncated } }';
const CHECK_QUERY =
  'query FirewallCheck($input: FirewallCheckInput!) { firewallCheck(input: $input) { evaluated truncated results { device { ' +
  CI +
  ' } chain verdict rule { ruleId name position chain action isPolicy } path uncertain { ruleId name position } } } }';

export const firewallKey = ['firewall'] as const;

export function firewallDevicesQuery(text: string) {
  return queryOptions({
    queryKey: [...firewallKey, 'devices', text] as const,
    queryFn: ({ signal }) =>
      gql<{ firewallDevices: FirewallDevice[] }>(DEVICES_QUERY, { text }, signal).then(
        (d) => d.firewallDevices,
      ),
  });
}

export function firewallPolicyQuery(deviceId: string | null) {
  return queryOptions({
    queryKey: [...firewallKey, 'policy', deviceId] as const,
    queryFn: ({ signal }) =>
      gql<{ firewallPolicy: FirewallPolicy }>(POLICY_QUERY, { deviceId }, signal).then(
        (d) => d.firewallPolicy,
      ),
    enabled: deviceId !== null,
  });
}

export function firewallCheckQuery(input: FirewallCheckInput | null) {
  return queryOptions({
    queryKey: [...firewallKey, 'check', input] as const,
    queryFn: ({ signal }) =>
      gql<{ firewallCheck: FirewallCheck }>(CHECK_QUERY, { input }, signal).then((d) => d.firewallCheck),
    enabled: input !== null,
  });
}
