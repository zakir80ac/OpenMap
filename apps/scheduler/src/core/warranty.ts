// REQ-CMDB-024 (ADR-043) — plans warranty and EoX lookups from the CMDB: every current hardware CI with a serial whose
// manufacturer maps to a vendor adapter, grouped per vendor and chunked into jobs of WARRANTY.assetsPerJob, only for
// the vendors the tenant has a stored credential for. The jobs run on a Discovery Node like any account collector.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, DISCOVERY, WARRANTY } from '@openmap/constants';
import { collectorJobSchema, type CollectorJob, type CredentialType } from '@openmap/contracts';

export type WarrantyVendor = keyof typeof WARRANTY.manufacturerPrefixes;

export const WARRANTY_VENDORS = Object.keys(WARRANTY.manufacturerPrefixes) as WarrantyVendor[];

export interface HardwareRow {
  ciType: string;
  name: string;
  serialNumber: string | null;
  manufacturer: string | null;
}

export interface VendorEndpoint {
  apiUrl: string;
  /** OAuth token endpoint; absent for vendors that authenticate with a static key. */
  tokenUrl?: string;
}

export interface WarrantyPlanInput {
  tenantId: string;
  nodeId: string;
  rows: readonly HardwareRow[];
  endpoints: Record<WarrantyVendor, VendorEndpoint>;
  /** Vault references of the stored vendor credentials; a vendor without one is not planned. */
  credentialRefs: Partial<Record<WarrantyVendor, string>>;
  /** Extra options every job carries (simulated mode pins its CA here). */
  options?: Record<string, unknown>;
  now: string;
}

const CREDENTIAL_TYPE: Record<WarrantyVendor, CredentialType> = {
  dell: 'oauth_client',
  lenovo: 'api_token',
  cisco: 'oauth_client',
};

export function warrantyVendorOf(manufacturer: string | null): WarrantyVendor | null {
  const m = manufacturer?.trim().toLowerCase() ?? '';
  if (m === '') return null;
  for (const vendor of WARRANTY_VENDORS) {
    if (WARRANTY.manufacturerPrefixes[vendor].some((p) => m.startsWith(p))) return vendor;
  }
  return null;
}

export interface WarrantyPlan {
  jobs: CollectorJob[];
  /** Assets per vendor that were planned. */
  planned: Partial<Record<WarrantyVendor, number>>;
  /** Assets per vendor skipped because the tenant has no credential for it. */
  withoutCredential: Partial<Record<WarrantyVendor, number>>;
  /** Hardware with a serial whose manufacturer no adapter covers. */
  unsupported: number;
}

export function planWarrantyJobs(input: WarrantyPlanInput): WarrantyPlan {
  const byVendor = new Map<WarrantyVendor, Array<{ serialNumber: string; ciType: string; name: string }>>();
  const seen = new Set<string>();
  let unsupported = 0;
  for (const row of input.rows) {
    const serial = row.serialNumber?.trim() ?? '';
    if (serial === '' || !(WARRANTY.ciTypes as readonly string[]).includes(row.ciType)) continue;
    const vendor = warrantyVendorOf(row.manufacturer);
    if (vendor === null) {
      unsupported += 1;
      continue;
    }
    const key = vendor + '|' + serial.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byVendor.get(vendor) ?? [];
    list.push({ serialNumber: serial, ciType: row.ciType, name: row.name });
    byVendor.set(vendor, list);
  }
  const plan: WarrantyPlan = { jobs: [], planned: {}, withoutCredential: {}, unsupported };
  for (const vendor of WARRANTY_VENDORS) {
    const assets = (byVendor.get(vendor) ?? []).sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
    if (assets.length === 0) continue;
    const ref = input.credentialRefs[vendor];
    if (ref === undefined) {
      plan.withoutCredential[vendor] = assets.length;
      continue;
    }
    plan.planned[vendor] = assets.length;
    const endpoint = input.endpoints[vendor];
    for (let i = 0; i < assets.length; i += WARRANTY.assetsPerJob) {
      plan.jobs.push(
        collectorJobSchema.parse({
          jobId: randomUUID(),
          tenantId: input.tenantId,
          collectorId: WARRANTY.collectorId,
          nodeId: input.nodeId,
          targets: [{ kind: 'account', value: endpoint.apiUrl, label: vendor }],
          credentialRef: ref,
          credentialType: CREDENTIAL_TYPE[vendor],
          timeoutMs: DISCOVERY.defaultJobTimeoutMs,
          rateLimit: { concurrency: 1, requestsPerSecond: WARRANTY.requestsPerSecond },
          options: {
            ...input.options,
            vendor,
            apiUrl: endpoint.apiUrl,
            ...(endpoint.tokenUrl === undefined ? {} : { tokenUrl: endpoint.tokenUrl }),
            ...((WARRANTY.eoxVendors as readonly string[]).includes(vendor) ? { eox: true } : {}),
            assets: assets.slice(i, i + WARRANTY.assetsPerJob),
          },
          scheduledAt: input.now,
          contractVersion: CONTRACT_VERSIONS.collector,
        }),
      );
    }
  }
  return plan;
}
