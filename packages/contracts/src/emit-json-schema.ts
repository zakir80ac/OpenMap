// REQ-CORE-006 — emits schemas/*.schema.json from the zod definitions so Go collectors and
// external tools validate against the same contract. Run by `pnpm --filter @openmap/contracts build`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { ciSchema, observedCiSchema, relationshipSchema, observedRelationshipSchema } from './ci.js';
import { collectorJobSchema, collectorManifestSchema, collectorResultSchema } from './collector.js';
import { eventEnvelopeSchema, outboxRecordSchema } from './event.js';
import { assetRecordSchema, infraPlanSchema, supportContractSchema, vendorContactSchema } from './asset.js';
import { impactScenarioSchema, impactSimulationSchema } from './impact.js';
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
  ['event-envelope', eventEnvelopeSchema, CONTRACT_VERSIONS.event],
  ['outbox-record', outboxRecordSchema, CONTRACT_VERSIONS.event],
  ['asset-record', assetRecordSchema, CONTRACT_VERSIONS.ci],
  ['infra-plan', infraPlanSchema, CONTRACT_VERSIONS.ci],
  ['support-contract', supportContractSchema, CONTRACT_VERSIONS.ci],
  ['vendor-contact', vendorContactSchema, CONTRACT_VERSIONS.ci],
  ['impact-scenario', impactScenarioSchema, CONTRACT_VERSIONS.event],
  ['impact-simulation', impactSimulationSchema, CONTRACT_VERSIONS.event],
  ['integration-config', integrationConfigSchema, CONTRACT_VERSIONS.event],
  ['integration-delivery', integrationDeliverySchema, CONTRACT_VERSIONS.event],
  ['security-alert', securityAlertSchema, CONTRACT_VERSIONS.event],
];

for (const [name, schema, version] of entries) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  const withMeta = { $id: 'https://openmap.dev/contracts/' + name + '/' + version, title: name, version, ...json };
  writeFileSync(join(outDir, name + '.schema.json'), JSON.stringify(withMeta, null, 2) + '\n');
}
console.log('contracts: wrote ' + String(entries.length) + ' JSON schemas to ' + outDir);
