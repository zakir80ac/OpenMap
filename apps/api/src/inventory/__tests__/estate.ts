// REQ-INT-011 (ADR-072) — a small estate in a tenant of its own for the inventory integration tests (T-624, T-625),
// written straight to Postgres as discovery would leave it: a site with a rack, a host in the rack, a second host with
// the hypervisor that shares its FQDN, a VM on that hypervisor serving a business service through its application, a
// VM that only knows its site from its collector, a switch, a retired host and a database that is not an inventory type.
import { randomUUID } from 'node:crypto';
import type { CiLayer, CiType, RelationshipType } from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';

export const ESTATE = {
  site: 'RYD',
  fallbackSite: 'JED',
  app: 'app-01.inv.test',
  esx: 'esx-01.inv.test',
  web: 'vm-web-01.inv.test',
  batch: 'vm-batch-01',
  switch: 'core-sw-01',
  retired: 'old-01.inv.test',
  serviceCode: 'BS-PAYMENTS',
  serviceName: 'Payments',
  appIp: '192.0.2.11',
  esxIp: '192.0.2.12',
  webIp: '192.0.2.21',
  batchIp: '192.0.2.22',
  switchIp: '192.0.2.31',
} as const;

export interface Estate {
  tenantId: string;
  organizationId: string;
  ids: Record<'site' | 'rack' | 'app' | 'esx' | 'hypervisor' | 'web' | 'batch' | 'switch' | 'retired' | 'database' | 'service' | 'application' | 'component', string>;
}

export async function createEstate(prisma: PrismaClient): Promise<Estate> {
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: 'Inventory org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
  await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Inventory BU', slug: 'inv-' + tenantId.slice(0, 8) } });
  const now = new Date();
  const ci = async (type: CiType, layer: CiLayer, name: string, identity: Record<string, string>, attributes: Prisma.InputJsonObject = {}, tags: string[] = [], lifecycle: 'managed' | 'retired' = 'managed'): Promise<string> => {
    const id = randomUUID();
    await prisma.ci.create({
      data: {
        id, tenantId, type, identity, identityKey: type + ':' + name, name, displayName: name, code: 'INV-' + id.slice(0, 8).toUpperCase(),
        layer, lifecycle, attributes, tags, sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1,
        observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
      },
    });
    return id;
  };
  const rel = (type: RelationshipType, fromCiId: string, toCiId: string): Promise<unknown> =>
    prisma.relationship.create({ data: { tenantId, type, fromCiId, toCiId, attributes: {}, sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });

  const e = ESTATE;
  const site = await ci('site', 'dc', 'Riyadh DC', { code: e.site });
  const rack = await ci('rack', 'dc', 'RYD-R01', { name: 'RYD-R01' });
  const app = await ci('host', 'hardware', 'app-01', { serialNumber: 'INV-APP', fqdn: e.app }, { managementIp: e.appIp, osName: 'RHEL', osVersion: '9.4', puppetClasses: ['role::app', 'profile::base'], puppetEnvironment: 'staging', chefEnvironment: 'prod' }, ['pci', 'linux']);
  const esx = await ci('host', 'hardware', 'esx-01', { serialNumber: 'INV-ESX', fqdn: e.esx }, { managementIp: e.esxIp }, ['hypervisor']);
  const hypervisor = await ci('hypervisor', 'virtualization', 'esx-01', { fqdn: e.esx }, { platform: 'vmware', osName: 'ESXi' }, ['vmware']);
  const web = await ci('vm', 'virtualization', 'vm-web-01', { instanceUuid: randomUUID() }, { fqdn: e.web, ipAddress: e.webIp, guestOs: 'Ubuntu 24.04' }, ['linux', 'web']);
  const batch = await ci('vm', 'virtualization', e.batch, { instanceUuid: randomUUID() }, { ipAddress: e.batchIp, site: e.fallbackSite }, ['linux']);
  const sw = await ci('network_device', 'network_security', e.switch, { serialNumber: 'INV-SW', managementIp: e.switchIp }, { manufacturer: 'Arista', model: '7050X' });
  const retired = await ci('host', 'hardware', 'old-01', { serialNumber: 'INV-OLD', fqdn: e.retired }, {}, [], 'retired');
  const database = await ci('database', 'databases', 'payments-db', { name: 'payments-db' });
  const service = await ci('business_service', 'applications', e.serviceName, { name: e.serviceName });
  await prisma.ci.update({ where: { id: service }, data: { code: e.serviceCode } });
  const application = await ci('application', 'applications', 'Payments app', { name: 'Payments app' });
  const component = await ci('application_component', 'applications', 'payments-web', { name: 'payments-web' });

  await rel('located_in', rack, site);
  await rel('located_in', app, rack);
  await rel('located_in', esx, rack);
  await rel('hosted_on', hypervisor, esx);
  await rel('runs_on', web, hypervisor);
  await rel('part_of_service', application, service);
  await rel('contains', application, component);
  await rel('runs_on', component, web);
  await rel('hosted_on', database, app);

  return { tenantId, organizationId, ids: { site, rack, app, esx, hypervisor, web, batch, switch: sw, retired, database, service, application, component } };
}

export async function dropEstate(prisma: PrismaClient, estate: Estate | undefined): Promise<void> {
  if (estate === undefined) return;
  await prisma.outboxEvent.deleteMany({ where: { tenantId: estate.tenantId } });
  await prisma.tenant.deleteMany({ where: { id: estate.tenantId } });
  await prisma.organization.deleteMany({ where: { id: estate.organizationId } });
}
