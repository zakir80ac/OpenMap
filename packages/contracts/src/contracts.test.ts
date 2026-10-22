// T-005 REQ-CORE-001 REQ-CORE-002 REQ-CORE-005 REQ-CORE-006
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  CI_LAYERS,
  CI_TYPES,
  CI_TYPE_LAYER,
  CI_IDENTITY_KEYS,
  ciCode,
  collectorResultSchema,
  eventEnvelopeSchema,
  observedCiSchema,
  impactScenarioSchema,
  integrationConfigSchema,
  assetRecordSchema,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const uuid = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const now = '2026-10-22T09:00:00.000Z';

describe('CI contract', () => {
  it('generates short codes per layer and business services', () => {
    expect(ciCode('network_security', 'network_device', 'sw-core-1')).toBe('NET-SW-CORE-1');
    expect(ciCode('applications', 'business_service', 'Online banking')).toBe('BS-ONLINE-BANKING');
    expect(ciCode('hardware', 'host', 'db-ryd-pg-core-01.bank.local')).toBe('SRV-DB-RYD-PG-CORE-01');
    expect(ciCode('unknown', 'unknown', '***')).toBe('UNK-UNNAMED');
  });
  it('maps every CI type to a layer and identity keys', () => {
    for (const t of CI_TYPES) {
      expect(CI_LAYERS).toContain(CI_TYPE_LAYER[t]);
      expect(CI_IDENTITY_KEYS[t].length).toBeGreaterThan(0);
    }
  });
  it('rejects an observed CI without identity', () => {
    const r = observedCiSchema.safeParse({ type: 'host', identity: {}, name: 'h', attributes: {}, tags: [], externalIds: [], observedAt: now });
    expect(r.success).toBe(false);
  });
});

describe('collector contract', () => {
  it('accepts a minimal successful result', () => {
    const r = collectorResultSchema.safeParse({
      jobId: uuid, runId: uuid, tenantId: uuid, collectorId: 'snmp', nodeId: 'node-1', status: 'success', startedAt: now, finishedAt: now,
      cis: [{ type: 'network_device', identity: { serialNumber: 'X1' }, name: 'sw1', attributes: { sysName: 'sw1' }, tags: [], externalIds: [], observedAt: now }],
      relationships: [], evidence: [], errors: [],
      metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 1, relationshipsEmitted: 0, durationMs: 10 }, contractVersion: '0.1.0',
    });
    expect(r.success).toBe(true);
  });
});

describe('event contract', () => {
  it('requires the tenantid extension and a known type', () => {
    const base = { specversion: '1.0', id: uuid, source: '/openmap/reconciler', subject: uuid, time: now, datacontenttype: 'application/json', dataschema: 'x', data: {} };
    expect(eventEnvelopeSchema.safeParse({ ...base, type: 'openmap.ci.created', tenantid: uuid }).success).toBe(true);
    expect(eventEnvelopeSchema.safeParse({ ...base, type: 'openmap.nothing', tenantid: uuid }).success).toBe(false);
  });
});

describe('asset, impact and integration contracts', () => {
  it('validate representative records', () => {
    expect(impactScenarioSchema.safeParse({ id: uuid, tenantId: uuid, name: 'R12 power', kind: 'power', failedCiIds: [uuid], options: { maxDepth: 0, honourRedundancy: true, includeSharedServices: true, at: null }, createdBy: 'syed', createdAt: now, changeRef: null, runbook: { code: 'RB-FAC-04', title: 'STS transfer', steps: [{ order: 1, instruction: 'Verify STS engaged', automation: null, estimatedMinutes: 1 }], ownerTeam: 'Facilities', lastReviewedAt: null } }).success).toBe(true);
    expect(integrationConfigSchema.safeParse({ id: uuid, tenantId: uuid, category: 'itsm', vendor: 'servicenow', name: 'SN', enabled: true, direction: 'bidirectional', endpoint: 'https://example.invalid', credentialRef: 'openmap/itsm/snow', settings: {}, fieldMappings: [], classMappings: [], subscribedEvents: ['openmap.incident.opened'], schedule: null, createdAt: now, updatedAt: now }).success).toBe(true);
    expect(assetRecordSchema.safeParse({ id: uuid, tenantId: uuid, ciId: null, assetTag: 'AST-1', serialNumber: null, manufacturer: 'Dell', model: 'R760', partNumber: null, stage: 'planned', stageChangedAt: now, locationCiId: null, custodian: null, ownerCostCentreCiId: null, planId: uuid, purchasedAt: null, purchaseCost: null, depreciation: { method: 'straight_line', usefulLifeMonths: 60, residualValue: { amount: 0, currency: 'SAR' } }, warranty: null, supportContractId: null, endOfLife: null, stock: null, tags: [], customFields: {}, createdAt: now, updatedAt: now }).success).toBe(true);
  });
});

describe('GraphQL contract', () => {
  it('parses and exposes the core operations', () => {
    const sdl = readFileSync(join(here, '..', 'graphql', 'schema.graphql'), 'utf8');
    const schema = buildSchema(sdl);
    const q = schema.getQueryType();
    expect(q?.getFields()['impact']).toBeDefined();
    expect(q?.getFields()['layers']).toBeDefined();
    expect(schema.getMutationType()?.getFields()['runSimulation']).toBeDefined();
    const layerEnum = schema.getType('CiLayer');
    expect(layerEnum && 'getValues' in layerEnum ? layerEnum.getValues().map((v) => v.name) : []).toEqual([...CI_LAYERS]);
  });
});
