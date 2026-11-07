// REQ-QA-001 — cloud regions: an Azure subscription and an AWS account with resources that carry
// cost and ownership tags, plus S3 buckets as object_bucket CIs.
import { CLOUD_RESOURCE_TYPES, ORGANIZATION_NAME } from '../catalog.js';
import type { Slot } from '../estate.js';
import { stableUuid, type Rng } from '../rng.js';
import { dateAt, isoAt, MS_PER_DAY } from '../time.js';
import { pad, type SiteWorld, type World } from '../world.js';

const RESOURCES_PER_REGION_BASE = 120;
const BUCKETS_BASE = 10;
const AWS_ACCOUNT_DIGITS = 12;
const RESOURCE_AGE_DAYS_MAX = 1200;
const ENVIRONMENTS = ['prod', 'prod', 'prod', 'uat', 'dev'] as const;
const OWNERS = ['retail-digital', 'payments', 'data-platform', 'infra-core', 'security'] as const;
const COST_CENTRE_CODES = ['CC-1000', 'CC-2000', 'CC-3000', 'CC-4000', 'CC-4200'] as const;

function awsAccountId(rng: Rng): string {
  let id = '';
  for (let i = 0; i < AWS_ACCOUNT_DIGITS; i++) id += String(rng.int(i === 0 ? 1 : 0, 9));
  return id;
}

export function cloudSlot(world: World, site: SiteWorld): Slot {
  const provider = site.def.cloud?.provider;
  if (!provider) throw new Error('not a cloud site: ' + site.def.code);
  const accountId = site.cloudAccountIdx >= 0 ? world.b.ref(site.cloudAccountIdx) : site.def.code;
  return world.b.slotFor('cloud|' + site.def.code, {
    family: provider === 'azure' ? 'cloud_azure' : 'cloud_aws',
    collectorId: provider === 'azure' ? 'cloud-azure' : 'cloud-aws',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'account', value: accountId, label: site.def.name },
    evidenceKind: 'api_response',
  });
}

function shortType(type: string): string {
  const tail = type.split(/[/:]/).pop() ?? type;
  return tail
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/s$/, '');
}

/**
 * ARN resource part per CloudFormation type, in the form each AWS service writes it (service, then the resource with
 * its own separator): RDS uses "db:<name>", Lambda "function:<name>", SQS the bare queue name, the rest "<kind>/<id>".
 */
const AWS_ARN_FORMS: Readonly<Record<string, { service: string; resource: (name: string) => string }>> = {
  'AWS::EC2::VPC': { service: 'ec2', resource: (n) => 'vpc/' + n },
  'AWS::EC2::Instance': { service: 'ec2', resource: (n) => 'instance/' + n },
  'AWS::EC2::SecurityGroup': { service: 'ec2', resource: (n) => 'security-group/' + n },
  'AWS::EC2::Volume': { service: 'ec2', resource: (n) => 'volume/' + n },
  'AWS::RDS::DBInstance': { service: 'rds', resource: (n) => 'db:' + n },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { service: 'elasticloadbalancing', resource: (n) => 'loadbalancer/app/' + n + '/' + stableUuid('aws-elb/' + n).replace(/-/g, '').slice(0, ELB_ID_HEX_LENGTH) },
  'AWS::Lambda::Function': { service: 'lambda', resource: (n) => 'function:' + n },
  'AWS::KMS::Key': { service: 'kms', resource: (n) => 'key/' + stableUuid('aws-kms/' + n) },
  'AWS::DynamoDB::Table': { service: 'dynamodb', resource: (n) => 'table/' + n },
  'AWS::SQS::Queue': { service: 'sqs', resource: (n) => n },
  'AWS::EKS::Cluster': { service: 'eks', resource: (n) => 'cluster/' + n },
};
const ELB_ID_HEX_LENGTH = 16;

/** The ARN AWS gives a resource of a CloudFormation type, so the AWS collector reconciles it. */
export function awsArn(type: string, region: string, accountId: string, name: string): string {
  const form = AWS_ARN_FORMS[type];
  if (!form) throw new Error('no ARN form for ' + type);
  return 'arn:aws:' + form.service + ':' + region + ':' + accountId + ':' + form.resource(name);
}

export function generateCloud(world: World, rng: Rng): void {
  const { b } = world;
  for (const site of world.sites) {
    const cloud = site.def.cloud;
    if (!cloud) continue;
    const accountId = cloud.provider === 'azure' ? rng.uuid() : awsAccountId(rng);
    const regionShort = cloud.region.replace(/[^a-z0-9]/g, '');
    // Open the slot before the account exists so its target is the region label; the account id is in identity.
    const slot = cloudSlot(world, site);
    slot.target = { kind: 'account', value: accountId, label: site.def.name };
    const accountIdx = b.ci(
      slot,
      'cloud_account',
      { provider: cloud.provider, accountId },
      ORGANIZATION_NAME + ' ' + (cloud.provider === 'azure' ? 'Azure Production' : 'AWS Production'),
      {
        provider: cloud.provider,
        accountId,
        displayName: cloud.provider === 'azure' ? 'sub-horizon-prod' : 'horizon-prod',
        region: cloud.region,
        directoryTenantId: cloud.provider === 'azure' ? rng.uuid() : null,
        environment: 'production',
        billingCurrency: 'USD',
        landingZone: 'hub-spoke',
        complianceScope: ['SAMA CSF', 'PCI DSS 4.0'],
        subscriptionStart: dateAt(-rng.int(30, 700)),
        subscriptionEnd: dateAt(rng.int(30, 365)),
        creditsRemaining: rng.int(5_000, 250_000),
        creditsUnit: 'USD',
        creditsCurrency: 'USD',
        creditsAsOf: isoAt(0),
      },
      site.def.code,
      { tags: ['cloud', cloud.provider] },
    );
    site.cloudAccountIdx = accountIdx;
    b.rel(slot, 'located_in', accountIdx, site.ciIdx);

    const types = CLOUD_RESOURCE_TYPES[cloud.provider];
    const count = b.count(RESOURCES_PER_REGION_BASE);
    for (let i = 0; i < count; i++) {
      const type = types[i % types.length] ?? types[0];
      if (!type) throw new Error('no cloud resource types for ' + cloud.provider);
      const env = rng.pick(ENVIRONMENTS);
      const name =
        shortType(type) + '-' + env + '-' + regionShort + '-' + pad(Math.floor(i / types.length) + 1, 3);
      const resourceGroup = 'rg-' + env + '-' + regionShort + '-' + pad((i % 6) + 1, 2);
      const resourceId =
        cloud.provider === 'azure'
          ? '/subscriptions/' +
            accountId +
            '/resourceGroups/' +
            resourceGroup +
            '/providers/' +
            type +
            '/' +
            name
          : awsArn(type, cloud.region, accountId, name);
      const idx = b.ci(
        slot,
        'cloud_resource',
        { provider: cloud.provider, resourceId },
        name,
        {
          resourceType: type,
          region: cloud.region,
          resourceGroup: cloud.provider === 'azure' ? resourceGroup : null,
          vpc: cloud.provider === 'aws' ? 'vpc-' + rng.hex(17) : null,
          state: rng.chance(0.93) ? 'running' : 'stopped',
          sku: rng.pick([
            'Standard_D4s_v5',
            'Standard_E8s_v5',
            'm6i.xlarge',
            'r6i.2xlarge',
            'Standard_LRS',
            'gp3',
          ]),
          tagEnvironment: env,
          tagOwner: rng.pick(OWNERS),
          tagCostCentre: rng.pick(COST_CENTRE_CODES),
          monthlyCostUsd: Number(rng.float(12, 4800).toFixed(2)),
          createdAt: isoAt(-rng.int(1, RESOURCE_AGE_DAYS_MAX) * MS_PER_DAY),
        },
        site.def.code,
        { tags: ['cloud', cloud.provider, env], primary: true },
      );
      b.rel(slot, 'member_of', idx, accountIdx);
      b.rel(slot, 'billed_to', idx, accountIdx, {
        costCentre: String(b.get(idx).attributes['tagCostCentre']),
      });
    }

    if (cloud.provider === 'aws') {
      const endpoint = 's3.' + cloud.region + '.amazonaws.com';
      const buckets = b.count(BUCKETS_BASE);
      for (let i = 0; i < buckets; i++) {
        const name =
          'horizon-' +
          rng.pick(['statements', 'kyc-docs', 'backups', 'logs', 'datalake', 'exports']) +
          '-' +
          regionShort +
          '-' +
          pad(i + 1, 2);
        const idx = b.ci(
          slot,
          'object_bucket',
          { endpoint, name },
          name,
          {
            endpoint,
            region: cloud.region,
            versioning: rng.chance(0.7),
            encryption: 'SSE-KMS',
            sizeGb: rng.int(5, 90_000),
            objectCount: rng.int(1_000, 50_000_000),
            publicAccessBlocked: true,
            storageClass: 'INTELLIGENT_TIERING',
          },
          site.def.code,
          { tags: ['cloud', 'aws', 'storage'], primary: true },
        );
        b.rel(slot, 'member_of', idx, accountIdx);
      }
    }
  }
}

/** Adds a managed cloud resource (used by the Kubernetes generator for AKS/EKS clusters and nodes). */
export function addCloudResource(
  world: World,
  rng: Rng,
  site: SiteWorld,
  type: string,
  name: string,
  extra: Record<string, string | number | boolean | null>,
): number {
  const cloud = site.def.cloud;
  if (!cloud || site.cloudAccountIdx < 0) throw new Error('cloud account missing for ' + site.def.code);
  const slot = cloudSlot(world, site);
  const accountId = world.b.ref(site.cloudAccountIdx);
  const regionShort = cloud.region.replace(/[^a-z0-9]/g, '');
  const resourceId =
    cloud.provider === 'azure'
      ? '/subscriptions/' +
        accountId +
        '/resourceGroups/rg-k8s-' +
        regionShort +
        '/providers/' +
        type +
        '/' +
        name
      : awsArn(type, cloud.region, accountId, name);
  const idx = world.b.ci(
    slot,
    'cloud_resource',
    { provider: cloud.provider, resourceId },
    name,
    {
      resourceType: type,
      region: cloud.region,
      state: 'running',
      tagEnvironment: 'prod',
      tagOwner: 'platform-engineering',
      tagCostCentre: 'CC-4000',
      monthlyCostUsd: Number(rng.float(200, 9000).toFixed(2)),
      ...extra,
    },
    site.def.code,
    { tags: ['cloud', cloud.provider, 'kubernetes'], primary: true },
  );
  world.b.rel(slot, 'member_of', idx, site.cloudAccountIdx);
  return idx;
}
