// T-010 REQ-CORE-009 — schema.prisma mirrors every contract enum and models every entity.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@openmap/constants';
import {
  ASSET_STAGES,
  CI_LAYERS,
  CI_TYPES,
  COLLECTOR_FAMILIES,
  CREDENTIAL_TYPES,
  DELIVERY_STATES,
  DEPRECIATION_METHODS,
  DIRECTIONS,
  EVENT_TYPES,
  EVIDENCE_KINDS,
  INTEGRATION_CATEGORIES,
  LIFECYCLES,
  LINK_KINDS,
  ONBOARDING_STEPS,
  PLAN_KINDS,
  PLAN_STATUSES,
  RELATIONSHIP_TYPES,
  RESULT_STATUSES,
  SCENARIO_KINDS,
  DASHBOARD_PERSONAS,
  SITE_KINDS,
  TARGET_KINDS,
  outboxRecordSchema,
} from '@openmap/contracts';
import { PACKAGE_ROOT } from './files.js';

const schema = readFileSync(join(PACKAGE_ROOT, 'prisma', 'schema.prisma'), 'utf8');

function enumMembers(name: string): string[] {
  const m = new RegExp('^enum ' + name + ' \\{\\n([\\s\\S]*?)^\\}', 'm').exec(schema);
  if (!m) throw new Error('enum ' + name + ' missing');
  return (m[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => l.split(/\s+/)[0] ?? '');
}

function modelBlock(name: string): string {
  const m = new RegExp('^model ' + name + ' \\{\\n([\\s\\S]*?)^\\}', 'm').exec(schema);
  if (!m) throw new Error('model ' + name + ' missing');
  return m[1] ?? '';
}

const ENUM_MIRRORS: Array<[string, readonly string[]]> = [
  ['Locale', LOCALES],
  ['CiLayer', CI_LAYERS],
  ['CiType', CI_TYPES],
  ['RelationshipType', RELATIONSHIP_TYPES],
  ['Lifecycle', LIFECYCLES],
  ['SiteKind', SITE_KINDS],
  ['LinkKind', LINK_KINDS],
  ['OnboardingStep', ONBOARDING_STEPS],
  ['CollectorFamily', COLLECTOR_FAMILIES],
  ['CredentialType', CREDENTIAL_TYPES],
  ['TargetKind', TARGET_KINDS],
  ['EvidenceKind', EVIDENCE_KINDS],
  ['ResultStatus', RESULT_STATUSES],
  ['OutboxTarget', outboxRecordSchema.shape.pending.element.options],
  ['AssetStage', ASSET_STAGES],
  ['DepreciationMethod', DEPRECIATION_METHODS],
  ['PlanKind', PLAN_KINDS],
  ['PlanStatus', PLAN_STATUSES],
  ['ScenarioKind', SCENARIO_KINDS],
  ['DashboardPersona', DASHBOARD_PERSONAS],
  ['IntegrationCategory', INTEGRATION_CATEGORIES],
  ['Direction', DIRECTIONS],
  ['DeliveryState', DELIVERY_STATES],
];

const MODELS = [
  'Tenant', 'TenantSettings', 'Organization', 'BusinessUnit', 'Site', 'SiteLink', 'Ci', 'CiExternalId', 'Relationship',
  'CollectorManifest', 'DiscoveryNode', 'DiscoveryJob', 'CollectorRun', 'Evidence', 'ReconciliationConflict', 'OutboxEvent',
  'AssetRecord', 'AssetAudit', 'InfraPlan', 'BomLine', 'VendorContact', 'ImpactScenario', 'ImpactSimulation',
  'ImpactValidation', 'Incident', 'IncidentLink', 'IntegrationConfig', 'IntegrationStatus', 'IntegrationDelivery', 'SecurityAlert',
  'AuditLog', 'UserPreference', 'OnboardingState',
];

/** Global tables: everything else carries tenantId. */
const GLOBAL_MODELS = new Set(['Organization', 'Tenant', 'Site', 'SiteLink', 'OnboardingState', 'CollectorManifest', 'TenantSettings', 'IntegrationStatus']);

describe('schema.prisma', () => {
  it('declares the postgresql datasource from POSTGRES_URL', () => {
    expect(schema).toMatch(/provider\s*=\s*"postgresql"/);
    expect(schema).toMatch(/url\s*=\s*env\("POSTGRES_URL"\)/);
    expect(schema.startsWith('// REQ-CORE-009')).toBe(true);
  });

  it.each(ENUM_MIRRORS)('enum %s mirrors the contract exactly', (name, contract) => {
    expect(enumMembers(name)).toEqual([...contract]);
  });

  it('keeps the event type as a string column because EVENT_TYPES grows', () => {
    expect(schema).not.toMatch(/^enum EventType/m);
    expect(modelBlock('OutboxEvent')).toMatch(/^\s*type\s+String\b/m);
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
  });

  it.each(MODELS)('models %s', (name) => {
    const block = modelBlock(name);
    expect(block).toMatch(/@@map\("[a-z_]+"\)/);
    if (!GLOBAL_MODELS.has(name)) expect(block).toMatch(/^\s*tenantId\s+String/m);
  });

  it('timestamps every model', () => {
    for (const name of MODELS) expect(modelBlock(name)).toMatch(/^\s*createdAt\s+DateTime/m);
  });

  it('makes Ci and Relationship bitemporal with provenance and the required indexes', () => {
    for (const name of ['Ci', 'Relationship']) {
      const block = modelBlock(name);
      expect(block).toMatch(/^\s*validFrom\s+DateTime\b/m);
      expect(block).toMatch(/^\s*validTo\s+DateTime\?/m);
      expect(block).toMatch(/^\s*observedAt\s+DateTime\b/m);
      for (const col of ['sourceCollectorId', 'sourceNodeId', 'sourceRunId', 'sourceConfidence']) expect(block).toContain(col);
      expect(block).toContain('@@index([tenantId, validTo])');
    }
    const ci = modelBlock('Ci');
    expect(ci).toMatch(/^\s*identity\s+Json/m);
    expect(ci).toMatch(/^\s*attributes\s+Json/m);
    expect(ci).toMatch(/^\s*userLabel\s+Json\?/m);
    expect(ci).toMatch(/^\s*layer\s+CiLayer/m);
    expect(ci).toMatch(/^\s*lifecycle\s+Lifecycle/m);
    expect(ci).toMatch(/^\s*checksum\s+String\s+@db\.Char\(64\)/m);
    expect(ci).toContain('@@index([tenantId, type])');
    expect(ci).toContain('@@index([tenantId, layer])');
    expect(ci).toContain('@@index([attributes(ops: JsonbPathOps)], type: Gin)');
    const rel = modelBlock('Relationship');
    expect(rel).toContain('@@index([fromCiId])');
    expect(rel).toContain('@@index([toCiId])');
    expect(rel).toContain('@@index([tenantId, type])');
  });

  it('models the outbox with a bigserial sequence, envelope, pending targets, attempts and deliveredAt', () => {
    const block = modelBlock('OutboxEvent');
    expect(block).toMatch(/^\s*sequence\s+BigInt\s+@id\s+@default\(autoincrement\(\)\)/m);
    expect(block).toMatch(/^\s*envelope\s+Json/m);
    expect(block).toMatch(/^\s*pending\s+OutboxTarget\[\]/m);
    expect(block).toMatch(/^\s*attempts\s+Int/m);
    expect(block).toMatch(/^\s*deliveredAt\s+DateTime\?/m);
    expect(block).toContain('@@index([deliveredAt])');
  });

  it('embeds warranty as JSON on AssetRecord and tracks node certificate expiry', () => {
    expect(modelBlock('AssetRecord')).toMatch(/^\s*warranty\s+Json\?/m);
    const node = modelBlock('DiscoveryNode');
    expect(node).toMatch(/^\s*certificateExpiresAt\s+DateTime\?/m);
    expect(node).toMatch(/^\s*siteId\s+String/m);
    expect(modelBlock('Evidence')).toMatch(/^\s*digest\s+String\s+@db\.Char\(64\)/m);
    expect(modelBlock('UserPreference')).toMatch(/^\s*visibleLayers\s+CiLayer\[\]/m);
  });
});
