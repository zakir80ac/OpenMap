// REQ-CMDB-039 — the asset register follows the CMDB (ADR-023): every CI of an owned type gets one asset row the
// first time it is persisted, and the fields discovery observes (serial, make and model, warranty, subscription)
// are refreshed on every later update without touching what a person entered. One array-based statement per batch,
// like the CI writes, so a 10k-device sweep stays inside its budget.
import { ASSETS, MONEY } from '@openmap/constants';
import { assetFieldsFromCi, isOwnedCiType, type Ci } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface AssetRow {
  tenantId: string;
  ciId: string;
  ciType: string;
  layer: string;
  /** The CI's short code: the fallback tag when the preferred one is taken. */
  code: string;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  purchasedAt: string | null;
  currency: string;
  /** JSON text of warrantySchema, or null. */
  warranty: string | null;
  /** JSON text of supportSchema, or null. */
  support: string | null;
}

function currencyOf(attributes: Record<string, unknown>): string {
  const value = attributes['currency'];
  return typeof value === 'string' && value.length === MONEY.currencyCodeLength ? value : MONEY.noCurrency;
}

/** The register row a CI deserves, or null when its type is not owned. The tag prefers the organisation's own. */
export function assetRowFor(ci: Ci): AssetRow | null {
  if (!isOwnedCiType(ci.type)) return null;
  const fields = assetFieldsFromCi(ci.type, ci.attributes);
  return {
    tenantId: ci.tenantId,
    ciId: ci.id,
    ciType: ci.type,
    layer: ci.layer,
    code: ci.code,
    assetTag: fields.assetTag ?? ci.code,
    serialNumber: fields.serialNumber,
    manufacturer: fields.manufacturer,
    model: fields.model,
    partNumber: fields.partNumber,
    purchasedAt: fields.purchasedAt,
    currency: currencyOf(ci.attributes),
    warranty: fields.warranty === null ? null : JSON.stringify(fields.warranty),
    support: fields.support === null ? null : JSON.stringify(fields.support),
  };
}

export function assetRowsFor(cis: readonly Ci[]): AssetRow[] {
  return cis.map(assetRowFor).filter((row): row is AssetRow => row !== null);
}

async function insertRows(tx: Tx, rows: readonly AssetRow[], tag: (row: AssetRow) => string): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO asset_records (id, "tenantId", "ciId", "ciType", layer, source, "assetTag", "serialNumber", manufacturer, model, "partNumber",
      stage, "stageChangedAt", "purchasedAt", "depreciationMethod", "usefulLifeMonths", "residualValueAmount", "residualValueCurrency",
      warranty, support, tags, "customFields", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), u.tenant_id, u.ci_id, u.ci_type::"CiType", u.layer::"CiLayer", 'discovery'::"AssetSource", u.asset_tag, u.serial, u.manufacturer, u.model, u.part,
      'deployed'::"AssetStage", now(), CASE WHEN u.purchased_at IS NULL THEN NULL ELSE u.purchased_at::date END,
      'none'::"DepreciationMethod", ${ASSETS.defaultUsefulLifeMonths}, 0, u.currency,
      CASE WHEN u.warranty IS NULL THEN NULL ELSE u.warranty::jsonb END, CASE WHEN u.support IS NULL THEN NULL ELSE u.support::jsonb END,
      ARRAY[]::text[], '{}'::jsonb, now(), now()
    FROM unnest(
      ${rows.map((r) => r.tenantId)}::uuid[], ${rows.map((r) => r.ciId)}::uuid[], ${rows.map((r) => r.ciType)}::text[], ${rows.map((r) => r.layer)}::text[],
      ${rows.map(tag)}::text[], ${rows.map((r) => r.serialNumber)}::text[], ${rows.map((r) => r.manufacturer)}::text[], ${rows.map((r) => r.model)}::text[],
      ${rows.map((r) => r.partNumber)}::text[], ${rows.map((r) => r.purchasedAt)}::text[], ${rows.map((r) => r.currency)}::text[],
      ${rows.map((r) => r.warranty)}::text[], ${rows.map((r) => r.support)}::text[]
    ) AS u(tenant_id, ci_id, ci_type, layer, asset_tag, serial, manufacturer, model, part, purchased_at, currency, warranty, support)
    ON CONFLICT DO NOTHING`);
}

async function missingAmong(tx: Tx, rows: readonly AssetRow[]): Promise<AssetRow[]> {
  if (rows.length === 0) return [];
  const present = await tx.$queryRaw<Array<{ ciId: string }>>(
    Prisma.sql`SELECT "ciId" FROM asset_records WHERE "ciId" = ANY(${rows.map((r) => r.ciId)}::uuid[])`,
  );
  const have = new Set(present.map((p) => p.ciId));
  return rows.filter((r) => !have.has(r.ciId));
}

/**
 * Creates the register rows for freshly created CIs. A preferred tag already taken by another asset (an organisation
 * re-using a label) falls back to the CI code, then to the CI id, so every owned CI ends with exactly one row.
 * Returns how many rows exist for the batch afterwards.
 */
export async function insertAssetsBatch(tx: Tx, cis: readonly Ci[]): Promise<number> {
  const rows = assetRowsFor(cis);
  if (rows.length === 0) return 0;
  await insertRows(tx, rows, (r) => r.assetTag);
  const afterTag = await missingAmong(tx, rows);
  await insertRows(tx, afterTag, (r) => r.code);
  const afterCode = await missingAmong(tx, afterTag);
  await insertRows(tx, afterCode, (r) => r.ciId);
  return rows.length;
}

/**
 * Refreshes discovery-sourced rows of updated CIs: a value the collector reports replaces the stored one, a value it
 * does not report leaves the row alone; warranty and support are replaced only while they still come from a vendor
 * API, never over a person's entry.
 */
export async function refreshAssetsBatch(tx: Tx, cis: readonly Ci[]): Promise<void> {
  const rows = assetRowsFor(cis);
  if (rows.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE asset_records a SET
      "serialNumber" = COALESCE(u.serial, a."serialNumber"),
      manufacturer = COALESCE(u.manufacturer, a.manufacturer),
      model = COALESCE(u.model, a.model),
      "partNumber" = COALESCE(u.part, a."partNumber"),
      "purchasedAt" = COALESCE(CASE WHEN u.purchased_at IS NULL THEN NULL ELSE u.purchased_at::date END, a."purchasedAt"),
      warranty = CASE WHEN u.warranty IS NOT NULL AND (a.warranty IS NULL OR a.warranty->>'source' = 'vendor_api') THEN u.warranty::jsonb ELSE a.warranty END,
      support = CASE WHEN u.support IS NOT NULL AND (a.support IS NULL OR a.support->>'source' = 'vendor_api') THEN u.support::jsonb ELSE a.support END,
      "updatedAt" = now()
    FROM unnest(
      ${rows.map((r) => r.ciId)}::uuid[], ${rows.map((r) => r.serialNumber)}::text[], ${rows.map((r) => r.manufacturer)}::text[], ${rows.map((r) => r.model)}::text[],
      ${rows.map((r) => r.partNumber)}::text[], ${rows.map((r) => r.purchasedAt)}::text[], ${rows.map((r) => r.warranty)}::text[], ${rows.map((r) => r.support)}::text[]
    ) AS u(ci_id, serial, manufacturer, model, part, purchased_at, warranty, support)
    WHERE a."ciId" = u.ci_id AND a.source = 'discovery'::"AssetSource"`);
}
