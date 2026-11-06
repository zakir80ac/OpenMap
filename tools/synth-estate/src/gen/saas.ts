// REQ-CMDB-022 REQ-QA-001 — SaaS tenants as the SaaS collector reports them (Microsoft 365, Google Workspace,
// Salesforce, ServiceNow, Workday): one saas_tenant per vendor with users, active users, domains and SSO applications;
// one saas_application per subscribed product with seats bought and assigned, utilisation, status and the subscription
// term (some renewing soon, one expired); licensed_by the tenant, member_of the vendor; and data flows from the
// bank's own applications to the SaaS products they exchange data with (communicates_with, with the data class).
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { dateAt } from '../time.js';
import { primarySite, type World } from '../world.js';

interface ProductDef {
  name: string;
  sku: string;
  seats: readonly [number, number];
  /** Share of seats assigned, as a range. */
  assigned: readonly [number, number];
}

interface TenantDef {
  vendor: string;
  edition: string;
  region: string;
  products: readonly ProductDef[];
  /** Data class exchanged with the bank's applications. */
  dataClass: string;
}

const TENANTS: readonly TenantDef[] = [
  {
    vendor: 'Microsoft',
    edition: 'Enterprise',
    region: 'EMEA',
    dataClass: 'internal',
    products: [
      { name: 'Microsoft 365 E3', sku: 'SPE_E3', seats: [3200, 4200], assigned: [0.86, 0.97] },
      { name: 'Microsoft 365 E5', sku: 'SPE_E5', seats: [300, 600], assigned: [0.55, 0.8] },
      { name: 'Power BI Pro', sku: 'POWER_BI_PRO', seats: [250, 400], assigned: [0.35, 0.6] },
      { name: 'Teams Rooms Pro', sku: 'MTR_PREM', seats: [40, 80], assigned: [0.9, 1] },
    ],
  },
  {
    vendor: 'Google',
    edition: 'Business Plus',
    region: 'EU',
    dataClass: 'internal',
    products: [{ name: 'Google Workspace Business Plus', sku: 'Google-Apps-Unlimited', seats: [150, 300], assigned: [0.4, 0.7] }],
  },
  {
    vendor: 'Salesforce',
    edition: 'Enterprise',
    region: 'EU',
    dataClass: 'customer',
    products: [
      { name: 'Sales Cloud Enterprise', sku: 'SFDC-SALES-EE', seats: [350, 500], assigned: [0.8, 0.95] },
      { name: 'Service Cloud Enterprise', sku: 'SFDC-SERVICE-EE', seats: [200, 320], assigned: [0.85, 1] },
    ],
  },
  {
    vendor: 'ServiceNow',
    edition: 'ITSM Professional',
    region: 'EMEA',
    dataClass: 'operational',
    products: [{ name: 'IT Service Management Professional', sku: 'ITSM-PRO-FULFILLER', seats: [150, 220], assigned: [0.9, 1] }],
  },
  {
    vendor: 'Workday',
    edition: 'Enterprise',
    region: 'EU',
    dataClass: 'personal',
    products: [{ name: 'Workday Human Capital Management', sku: 'WD-HCM', seats: [4000, 5200], assigned: [0.92, 0.99] }],
  },
];

const ACTIVE_SHARE: readonly [number, number] = [0.72, 0.93];
const SSO_APPS: readonly [number, number] = [12, 140];
const TERM_DAYS = 365;
/** Days from today a term ends: some renew within the quarter, one has lapsed. */
const END_OFFSETS: readonly number[] = [-20, 25, 60, 140, 210, 300];
const FLOWS_PER_TENANT: readonly [number, number] = [1, 3];
const PERCENT = 100;

function between(rng: Rng, range: readonly [number, number]): number {
  return range[0] + rng.next() * (range[1] - range[0]);
}

function saasSlot(world: World): Slot {
  const site = primarySite(world);
  return world.b.slotFor('saas', {
    family: 'saas',
    collectorId: 'saas',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'account', value: 'saas-directory', label: 'SaaS tenants' },
    evidenceKind: 'api_response',
  });
}

export function generateSaas(world: World, rng: Rng): void {
  const { b } = world;
  const slot = saasSlot(world);
  const site = primarySite(world).def.code;
  let offset = 0;
  for (const def of TENANTS) {
    const tenantId = rng.uuid();
    const users = Math.round(between(rng, def.products[0]?.seats ?? [1, 1]));
    const vendorIdx = b.ci(slot, 'vendor', { name: def.vendor }, def.vendor, { kind: 'saas', source: 'saas' }, site, { tags: ['vendor', 'saas'] });
    const tenantIdx = b.ci(
      slot,
      'saas_tenant',
      { vendor: def.vendor, tenantId },
      def.vendor + ' ' + def.edition,
      {
        vendor: def.vendor,
        tenantId,
        displayName: 'Horizon Bank',
        domains: ['horizonbank.example'],
        region: def.region,
        edition: def.edition,
        users,
        activeUsers: Math.round(users * between(rng, ACTIVE_SHARE)),
        groups: rng.int(40, 400),
        ssoApplications: rng.int(SSO_APPS[0], SSO_APPS[1]),
        products: def.products.length,
        source: 'saas',
        health: 'healthy',
      },
      site,
      { tags: ['saas'], primary: true },
    );
    b.rel(slot, 'member_of', tenantIdx, vendorIdx);
    const appIdxs: number[] = [];
    for (const p of def.products) {
      const seats = Math.round(between(rng, p.seats));
      const assigned = Math.min(seats, Math.round(seats * between(rng, p.assigned)));
      const endOffset = END_OFFSETS[offset % END_OFFSETS.length] ?? TERM_DAYS;
      offset++;
      const expired = endOffset < 0;
      const appIdx = b.ci(
        slot,
        'saas_application',
        { vendor: def.vendor, product: p.name, tenantRef: tenantId },
        p.name,
        {
          vendor: def.vendor,
          product: p.name,
          sku: p.sku,
          seatsTotal: seats,
          seatsAssigned: assigned,
          seatUtilisationPercent: Math.floor((assigned * PERCENT) / seats),
          status: expired ? 'expired' : 'enabled',
          subscriptionStart: dateAt(endOffset - TERM_DAYS),
          subscriptionEnd: dateAt(endOffset),
          source: 'saas',
          health: expired ? 'degraded' : 'healthy',
        },
        site,
        { tags: ['saas'] },
      );
      b.rel(slot, 'licensed_by', appIdx, tenantIdx, { seatsTotal: seats, seatsAssigned: assigned });
      b.rel(slot, 'member_of', appIdx, vendorIdx);
      appIdxs.push(appIdx);
    }
    // Data flows: the bank's applications that exchange data with this tenant's products.
    const flows = rng.int(FLOWS_PER_TENANT[0], FLOWS_PER_TENANT[1]);
    for (let f = 0; f < flows && world.applications.length > 0; f++) {
      const app = rng.pick(world.applications);
      const target = rng.pick(appIdxs);
      b.rel(slot, 'communicates_with', app.idx, target, { protocol: 'https', dataClass: def.dataClass, direction: rng.chance(0.5) ? 'outbound' : 'bidirectional', integration: 'api' });
    }
  }
}
