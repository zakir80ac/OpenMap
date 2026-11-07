// REQ-CORE-006 — emits schemas/*.schema.json from the zod definitions so Go collectors and
// external tools validate against the same contract. Run by `pnpm --filter @openmap/contracts build`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { CI_IDENTITY_KEYS, GLOBAL_IDENTITY_KEYS, GLOBAL_IDENTITY_SCOPES, IDENTITY_REF_ALIAS_ATTRIBUTES, IDENTITY_REF_DERIVED, IDENTITY_REF_TARGETS, PARENT_IDENTITY_KEYS, ciSchema, metricSampleSchema, observedCiSchema, relationshipSchema, observedRelationshipSchema } from './ci.js';
import { collectorJobSchema, collectorManifestSchema, collectorResultSchema } from './collector.js';
import { eventEnvelopeSchema, outboxRecordSchema } from './event.js';
import { assetRecordSchema, infraPlanSchema, supportContractSchema, vendorContactSchema } from './asset.js';
import { dashboardInputSchema, dashboardSchema } from './dashboard.js';
import { openApiDocument } from './rest.js';
import { impactScenarioSchema, impactSimulationSchema, impactValidationSchema, relationshipSuggestionSchema } from './impact.js';
import { integrationConfigSchema, integrationDeliverySchema, securityAlertSchema } from './integration.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'schemas');
mkdirSync(outDir, { recursive: true });

const entries: Array<[string, z.ZodType, string]> = [
  ['ci', ciSchema, CONTRACT_VERSIONS.ci],
  ['observed-ci', observedCiSchema, CONTRACT_VERSIONS.ci],
  ['relationship', relationshipSchema, CONTRACT_VERSIONS.ci],
  ['observed-relationship', observedRelationshipSchema, CONTRACT_VERSIONS.ci],
  ['collector-manifest', collectorManifestSchema, CONTRACT_VERSIONS.collector],
  ['collector-job', collectorJobSchema, CONTRACT_VERSIONS.collector],
  ['collector-result', collectorResultSchema, CONTRACT_VERSIONS.collector],
  ['metric-sample', metricSampleSchema, CONTRACT_VERSIONS.ci],
  ['event-envelope', eventEnvelopeSchema, CONTRACT_VERSIONS.event],
  ['outbox-record', outboxRecordSchema, CONTRACT_VERSIONS.event],
  ['asset-record', assetRecordSchema, CONTRACT_VERSIONS.ci],
  ['infra-plan', infraPlanSchema, CONTRACT_VERSIONS.ci],
  ['support-contract', supportContractSchema, CONTRACT_VERSIONS.ci],
  ['vendor-contact', vendorContactSchema, CONTRACT_VERSIONS.ci],
  ['dashboard', dashboardSchema, CONTRACT_VERSIONS.graphql],
  ['dashboard-input', dashboardInputSchema, CONTRACT_VERSIONS.graphql],
  ['impact-scenario', impactScenarioSchema, CONTRACT_VERSIONS.event],
  ['impact-simulation', impactSimulationSchema, CONTRACT_VERSIONS.event],
  ['impact-validation', impactValidationSchema, CONTRACT_VERSIONS.event],
  ['relationship-suggestion', relationshipSuggestionSchema, CONTRACT_VERSIONS.event],
  ['integration-config', integrationConfigSchema, CONTRACT_VERSIONS.event],
  ['integration-delivery', integrationDeliverySchema, CONTRACT_VERSIONS.event],
  ['security-alert', securityAlertSchema, CONTRACT_VERSIONS.event],
];

for (const [name, schema, version] of entries) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  const withMeta = { $id: 'https://openmap.dev/contracts/' + name + '/' + version, title: name, version, ...json };
  writeFileSync(join(outDir, name + '.schema.json'), JSON.stringify(withMeta, null, 2) + '\n');
}
// The identity rules reconciliation applies (REQ-CORE-013), for Go tools that must judge merges the same way.
const identity = {
  $id: 'https://openmap.dev/contracts/ci-identity/' + CONTRACT_VERSIONS.ci,
  title: 'ci-identity',
  version: CONTRACT_VERSIONS.ci,
  keys: CI_IDENTITY_KEYS,
  global: [...GLOBAL_IDENTITY_KEYS],
  // ADR-045: issuer scopes of global keys, and how a `*Ref` value resolves to the CI it names.
  scopes: GLOBAL_IDENTITY_SCOPES,
  parentKeys: PARENT_IDENTITY_KEYS,
  refTargets: IDENTITY_REF_TARGETS,
  refAliasAttributes: IDENTITY_REF_ALIAS_ATTRIBUTES,
  refDerived: IDENTITY_REF_DERIVED,
};
writeFileSync(join(outDir, 'ci-identity.json'), JSON.stringify(identity, null, 2) + '\n');
// REQ-CORE-019 (ADR-049): the REST API's OpenAPI 3.1 document, from the same route table the API validates against.
const openApiDir = join(dirname(outDir), 'openapi');
mkdirSync(openApiDir, { recursive: true });
writeFileSync(join(openApiDir, 'openapi.json'), JSON.stringify(openApiDocument(CONTRACT_VERSIONS.rest), null, 2) + '\n');
console.log('contracts: wrote ' + String(entries.length) + ' JSON schemas, ci-identity.json and openapi/openapi.json to ' + dirname(outDir));
