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
  /**
   * The product name the vendor's API reports, which the SaaS collector puts in the identity: Microsoft Graph's SKU part
   * number, and the single product the Google Directory and Workday APIs expose. Absent when the API reports the name.
   */
  reported?: string;
  seats: readonly [number, number];
  /** Share of seats assigned, as a range. */
  assigned: readonly [number, number];
}

/** How each vendor issues tenant ids: an Entra GUID, a Google customer id, a Salesforce org id, an instance name. */
type TenantIdShape = 'guid' | 'google_customer' | 'salesforce_org' | 'instance';

interface TenantDef {
  vendor: string;
  idShape: TenantIdShape;
  edition: string;
  region: string;
  products: readonly ProductDef[];
  /** Data class exchanged with the bank's applications. */
  dataClass: string;
}

const TENANTS: readonly TenantDef[] = [
  {
    vendor: 'Microsoft',
    idShape: 'guid',
    edition: 'Enterprise',
    region: 'EMEA',
    dataClass: 'internal',
    products: [
      { name: 'Microsoft 365 E3', sku: 'SPE_E3', reported: 'SPE_E3', seats: [3200, 4200], assigned: [0.86, 0.97] },
      { name: 'Microsoft 365 E5', sku: 'SPE_E5', reported: 'SPE_E5', seats: [300, 600], assigned: [0.55, 0.8] },
      { name: 'Power BI Pro', sku: 'POWER_BI_PRO', reported: 'POWER_BI_PRO', seats: [250, 400], assigned: [0.35, 0.6] },
      { name: 'Teams Rooms Pro', sku: 'MTR_PREM', reported: 'MTR_PREM', seats: [40, 80], assigned: [0.9, 1] },
    ],
  },
  {
    vendor: 'Google',
    idShape: 'google_customer',
    edition: 'Business Plus',
    region: 'EU',
    dataClass: 'internal',
    products: [{ name: 'Google Workspace Business Plus', sku: 'Google-Apps-Unlimited', reported: 'Google Workspace', seats: [150, 300], assigned: [0.4, 0.7] }],
  },
  {
    vendor: 'Salesforce',
    idShape: 'salesforce_org',
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
    idShape: 'instance',
    edition: 'ITSM Professional',
    region: 'EMEA',
    dataClass: 'operational',
    products: [{ name: 'IT Service Management Professional', sku: 'ITSM-PRO-FULFILLER', seats: [150, 220], assigned: [0.9, 1] }],
  },
  {
    vendor: 'Workday',
    idShape: 'instance',
    edition: 'Enterprise',
    region: 'EU',
    dataClass: 'personal',
    products: [{ name: 'Workday Human Capital Management', sku: 'WD-HCM', reported: 'Workday HCM', seats: [4000, 5200], assigned: [0.92, 0.99] }],
  },
];

const ACTIVE_SHARE: readonly [number, number] = [0.72, 0.93];
const SSO_APPS: readonly [number, number] = [12, 140];
const TERM_DAYS = 365;
/** Days from today a term ends: some renew within the quarter, one has lapsed. */
const END_OFFSETS: readonly number[] = [-20, 25, 60, 140, 210, 300];
const FLOWS_PER_TENANT: readonly [number, number] = [1, 3];
const PERCENT = 100;

/** The ServiceNow instance and Workday tenant the bank signs in to (the subdomain both vendors issue). */
const INSTANCE_NAME = 'horizonbank';
const GOOGLE_CUSTOMER_PREFIX = 'C0';
const GOOGLE_CUSTOMER_LENGTH = 7;
const SALESFORCE_ORG_PREFIX = '00D';
const SALESFORCE_BODY_LENGTH = 12;
const SALESFORCE_CHUNK = 5;
const SALESFORCE_CHECKSUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MIXED_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Appends Salesforce's case-safe checksum to a 15-character id (one character per five, from its upper-case bits). */
function salesforceId18(id15: string): string {
  let out = id15;
  for (let c = 0; c < id15.length / SALESFORCE_CHUNK; c++) {
    let bits = 0;
    for (let i = 0; i < SALESFORCE_CHUNK; i++) {
      const ch = id15[c * SALESFORCE_CHUNK + i] ?? '';
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << i;
    }
    out += SALESFORCE_CHECKSUM[bits] ?? 'A';
  }
  return out;
}

/** A tenant id in the shape its vendor issues, so the SaaS collector's tenant reconciles to the estate's. */
function tenantIdOf(shape: TenantIdShape, rng: Rng): string {
  if (shape === 'guid') return rng.uuid();
  if (shape === 'google_customer') return GOOGLE_CUSTOMER_PREFIX + rng.alnum(GOOGLE_CUSTOMER_LENGTH, LOWER_ALNUM);
  if (shape === 'salesforce_org') return salesforceId18(SALESFORCE_ORG_PREFIX + rng.alnum(SALESFORCE_BODY_LENGTH, MIXED_ALNUM));
  return INSTANCE_NAME;
}

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
    const tenantId = tenantIdOf(def.idShape, rng);
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
        { vendor: def.vendor, product: p.reported ?? p.name, tenantRef: tenantId },
        p.name,
        {
          vendor: def.vendor,
          product: p.reported ?? p.name,
          displayName: p.name,
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
