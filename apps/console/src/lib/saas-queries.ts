// REQ-CMDB-022 — GraphQL operation behind the SaaS screen.
import { queryOptions } from '@tanstack/react-query';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';

export type SaasSubscriptionState = 'active' | 'renewing' | 'lapsed' | 'unknown';

export interface SaasSubscription {
  ci: CiSummary;
  product: string;
  sku: string | null;
  status: string | null;
  seatsTotal: number | null;
  seatsAssigned: number | null;
  unusedSeats: number | null;
  utilisationPercent: number | null;
  underused: boolean;
  subscriptionEnd: string | null;
  daysToRenewal: number | null;
  state: SaasSubscriptionState;
  dataFlows: Array<{ application: CiSummary; dataClass: string | null; direction: string | null }>;
}

export interface SaasTenant {
  ci: CiSummary;
  vendor: string;
  edition: string | null;
  users: number | null;
  activeUsers: number | null;
  ssoApplications: number | null;
  domains: string[];
  subscriptions: SaasSubscription[];
}

export interface SaasInventory {
  tenants: SaasTenant[];
  seatsTotal: number;
  seatsAssigned: number;
  unusedSeats: number;
  renewing: number;
  lapsed: number;
  dataFlows: number;
}

const QUERY =
  '{ saasInventory { seatsTotal seatsAssigned unusedSeats renewing lapsed dataFlows tenants { vendor edition users activeUsers ssoApplications domains ci { ' +
  CI_SUMMARY_FIELDS +
  ' } subscriptions { product sku status seatsTotal seatsAssigned unusedSeats utilisationPercent underused subscriptionEnd daysToRenewal state ci { ' +
  CI_SUMMARY_FIELDS +
  ' } dataFlows { dataClass direction application { ' +
  CI_SUMMARY_FIELDS +
  ' } } } } } }';

export function saasInventoryQuery() {
  return queryOptions({
    queryKey: ['saas-inventory'] as const,
    queryFn: ({ signal }) =>
      gql<{ saasInventory: SaasInventory }>(QUERY, undefined, signal).then((d) => d.saasInventory),
  });
}
