// REQ-CMDB-022 — the SaaS inventory over the SaaS collector's CIs: each tenant (Microsoft 365, Google Workspace,
// Salesforce, ServiceNow, Workday…) with users, active users, SSO applications and domains; its subscriptions
// (saas_application licensed_by the tenant) with seats bought and assigned, unused seats, the renewal date and whether
// it renews inside SAAS.renewalHorizonDays or has lapsed; and the data flows from the organisation's applications to
// each product (communicates_with, with the data class exchanged).
import { Injectable } from '@nestjs/common';
import { SAAS, TIME } from '@openmap/constants';
import type { Prisma } from '@openmap/db';
import { PrismaService } from '../db/prisma.service.js';

export type SubscriptionState = 'active' | 'renewing' | 'lapsed' | 'unknown';

export interface SaasDataFlowView {
  applicationId: string;
  productId: string;
  dataClass: string | null;
  direction: string | null;
}

export interface SaasSubscriptionView {
  ciId: string;
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
  state: SubscriptionState;
  dataFlows: SaasDataFlowView[];
}

export interface SaasTenantView {
  ciId: string;
  vendor: string;
  edition: string | null;
  users: number | null;
  activeUsers: number | null;
  ssoApplications: number | null;
  domains: string[];
  subscriptions: SaasSubscriptionView[];
}

export interface SaasInventoryView {
  tenants: SaasTenantView[];
  seatsTotal: number;
  seatsAssigned: number;
  unusedSeats: number;
  renewing: number;
  lapsed: number;
  dataFlows: number;
}

type Attrs = Record<string, unknown>;

function obj(v: Prisma.JsonValue): Attrs {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Attrs) : {};
}

function num(a: Attrs, k: string): number | null {
  const v = a[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(a: Attrs, k: string): string | null {
  const v = a[k];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** The subscription's renewal state from its end date. */
export function subscriptionState(end: string | null, status: string | null, now: Date, horizonDays: number): { state: SubscriptionState; days: number | null } {
  if (end === null) return { state: status === 'expired' ? 'lapsed' : 'unknown', days: null };
  const days = Math.floor((Date.parse(end) - now.getTime()) / TIME.msPerDay);
  if (Number.isNaN(days)) return { state: 'unknown', days: null };
  if (days < 0 || status === 'expired') return { state: 'lapsed', days };
  return { state: days <= horizonDays ? 'renewing' : 'active', days };
}

@Injectable()
export class SaasService {
  constructor(private readonly prisma: PrismaService) {}

  async inventory(tenantId: string, now: Date = new Date()): Promise<SaasInventoryView> {
    const cis = await this.prisma.client.ci.findMany({
      where: { tenantId, validTo: null, type: { in: ['saas_tenant', 'saas_application'] } },
      select: { id: true, type: true, displayName: true, attributes: true },
    });
    const ids = cis.map((c) => c.id);
    const rels = ids.length === 0 ? [] : await this.prisma.client.relationship.findMany({
      where: { tenantId, validTo: null, OR: [{ type: 'licensed_by', fromCiId: { in: ids } }, { type: 'communicates_with', toCiId: { in: ids } }] },
      select: { type: true, fromCiId: true, toCiId: true, attributes: true },
    });
    const tenantOf = new Map<string, string>();
    const flowsTo = new Map<string, SaasDataFlowView[]>();
    for (const r of rels) {
      if (r.type === 'licensed_by') tenantOf.set(r.fromCiId, r.toCiId);
      else {
        const a = obj(r.attributes);
        flowsTo.set(r.toCiId, [...(flowsTo.get(r.toCiId) ?? []), { applicationId: r.fromCiId, productId: r.toCiId, dataClass: str(a, 'dataClass'), direction: str(a, 'direction') }]);
      }
    }
    const tenants = new Map<string, SaasTenantView>();
    for (const c of cis.filter((x) => x.type === 'saas_tenant')) {
      const a = obj(c.attributes);
      const domains = Array.isArray(a['domains']) ? a['domains'].filter((d): d is string => typeof d === 'string') : [];
      tenants.set(c.id, { ciId: c.id, vendor: str(a, 'vendor') ?? c.displayName, edition: str(a, 'edition'), users: num(a, 'users'), activeUsers: num(a, 'activeUsers'), ssoApplications: num(a, 'ssoApplications'), domains, subscriptions: [] });
    }
    for (const c of cis.filter((x) => x.type === 'saas_application')) {
      const tenant = tenants.get(tenantOf.get(c.id) ?? '');
      if (tenant === undefined) continue;
      const a = obj(c.attributes);
      const total = num(a, 'seatsTotal');
      const assigned = num(a, 'seatsAssigned');
      const utilisation = total !== null && assigned !== null && total > 0 ? Math.floor((assigned * SAAS.fullPercent) / total) : null;
      const status = str(a, 'status');
      const end = str(a, 'subscriptionEnd');
      const renewal = subscriptionState(end, status, now, SAAS.renewalHorizonDays);
      tenant.subscriptions.push({
        ciId: c.id,
        product: str(a, 'product') ?? c.displayName,
        sku: str(a, 'sku'),
        status,
        seatsTotal: total,
        seatsAssigned: assigned,
        unusedSeats: total !== null && assigned !== null ? Math.max(0, total - assigned) : null,
        utilisationPercent: utilisation,
        underused: utilisation !== null && utilisation < SAAS.underusedPercent,
        subscriptionEnd: end,
        daysToRenewal: renewal.days,
        state: renewal.state,
        dataFlows: flowsTo.get(c.id) ?? [],
      });
    }
    const list = [...tenants.values()].sort((x, y) => x.vendor.localeCompare(y.vendor));
    for (const t of list) t.subscriptions.sort((x, y) => (x.daysToRenewal ?? Number.MAX_SAFE_INTEGER) - (y.daysToRenewal ?? Number.MAX_SAFE_INTEGER));
    const subs = list.flatMap((t) => t.subscriptions);
    const sum = (f: (s: SaasSubscriptionView) => number | null): number => subs.reduce((n, s) => n + (f(s) ?? 0), 0);
    return {
      tenants: list,
      seatsTotal: sum((s) => s.seatsTotal),
      seatsAssigned: sum((s) => s.seatsAssigned),
      unusedSeats: sum((s) => s.unusedSeats),
      renewing: subs.filter((s) => s.state === 'renewing').length,
      lapsed: subs.filter((s) => s.state === 'lapsed').length,
      dataFlows: sum((s) => s.dataFlows.length),
    };
  }
}
