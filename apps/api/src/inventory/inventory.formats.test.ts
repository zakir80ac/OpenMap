// T-620 REQ-INT-011 (ADR-072) — the inventory formats over hand-built nodes:
// - CIs naming the same FQDN merge into one node, the earliest inventory type speaking for it;
// - the node's address is its management IP before its FQDN, and its name the FQDN in lower case;
// - Ansible: hostvars under _meta with ansible_host, a group per facet value under a parent per facet, ungrouped hosts;
// - salt-ssh: host, user, port and sudo per minion id, facts as the openmap grain;
// - Puppet: classes from puppetClasses, the CI's environment before the request's before Puppet's default;
// - Chef: one role per site and service, each once, in the node's run list; the CI's environment first.
import { describe, expect, it } from 'vitest';
import { INVENTORY } from '@openmap/constants';
import {
  ansibleInventorySchema,
  chefExportSchema,
  inventoryGroupName,
  puppetNodesSchema,
  saltRosterSchema,
} from '@openmap/contracts';
import {
  ansibleInventory,
  chefExport,
  nameList,
  puppetNode,
  puppetNodes,
  saltRoster,
} from './inventory.formats.js';
import { mergeNodes, nodeName, type NodeInput } from './inventory.service.js';

const HOST = '00000000-0000-4000-8000-000000000001';
const HYPERVISOR = '00000000-0000-4000-8000-000000000002';
const VM = '00000000-0000-4000-8000-000000000003';
const SERVICE = { id: '00000000-0000-4000-8000-0000000000aa', code: 'BS-PAYMENTS', name: 'Payments' };

function input(
  id: string,
  type: string,
  identity: Record<string, unknown>,
  attributes: Record<string, unknown>,
  extra: Partial<NodeInput> = {},
): NodeInput {
  return {
    row: {
      id,
      code: 'SRV-' + id.slice(-1),
      name: 'ci-' + id.slice(-1),
      type,
      layer: 'hardware',
      lifecycle: 'managed',
      tags: [],
      identity,
      attributes,
    },
    site: null,
    services: [],
    ...extra,
  };
}

const inputs: NodeInput[] = [
  input(
    HYPERVISOR,
    'hypervisor',
    { fqdn: 'ESX-01.bank.local' },
    { platform: 'vmware' },
    { services: [SERVICE] },
  ),
  {
    ...input(
      HOST,
      'host',
      { fqdn: 'esx-01.bank.local' },
      {
        managementIp: '192.0.2.10',
        osName: 'ESXi',
        puppetClasses: 'role::esx, profile::base',
        chefEnvironment: 'dc',
      },
    ),
    site: 'HQ',
  },
  {
    ...input(
      VM,
      'vm',
      { instanceUuid: 'u-1' },
      { ipAddress: '192.0.2.20', osName: 'Ubuntu', puppetEnvironment: 'staging' },
    ),
    site: 'DR',
  },
];
const nodes = mergeNodes(
  inputs.map((i) => (i.row.id === HOST ? { ...i, row: { ...i.row, tags: ['pci', 'hardware'] } } : i)),
  ['osName', 'platform'],
);

describe('inventory nodes', () => {
  it('merges CIs that name the same node, the host speaking for the hypervisor', () => {
    expect(nodes.map((n) => n.name)).toEqual(['ci-3', 'esx-01.bank.local']);
    const esx = nodes[1];
    expect(esx?.facts).toMatchObject({
      id: HOST,
      mergedIds: [HYPERVISOR],
      type: 'host',
      site: 'HQ',
      tags: ['hardware', 'pci'],
      services: [SERVICE],
      attributes: { osName: 'ESXi', platform: 'vmware' },
    });
    expect(esx?.address).toBe('192.0.2.10');
    expect(nodes[0]?.address).toBe('192.0.2.20');
  });

  it('names a node by its FQDN in lower case, else by the CI name', () => {
    expect(nodeName({ identity: {}, attributes: { fqdn: 'Web-01.Example.Org' }, name: 'web' })).toBe(
      'web-01.example.org',
    );
    expect(nodeName({ identity: {}, attributes: {}, name: 'core-sw-1' })).toBe('core-sw-1');
  });

  it('reads a list setting from an array or a comma-separated string', () => {
    expect(nameList(['a', ' b '])).toEqual(['a', 'b']);
    expect(nameList('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(nameList(null)).toEqual([]);
  });

  it('names groups as Ansible accepts them, and never merges two non-Latin values', () => {
    expect(inventoryGroupName('service', 'BS-PAYMENTS')).toBe('service_bs_payments');
    expect(inventoryGroupName('tag', 'PCI DSS / zone 1')).toBe('tag_pci_dss_zone_1');
    const a = inventoryGroupName('tag', 'إنتاج');
    expect(a).toMatch(/^tag_x[0-9a-f]+$/u);
    expect(a).not.toBe(inventoryGroupName('tag', 'تطوير'));
  });
});

describe('Ansible dynamic inventory', () => {
  const inv = ansibleInventory(nodes, ['site', 'type', 'tag', 'service']);

  it('matches the contract and carries every host under _meta.hostvars', () => {
    expect(ansibleInventorySchema.safeParse(inv).success).toBe(true);
    expect(Object.keys(inv._meta.hostvars).sort()).toEqual(['ci-3', 'esx-01.bank.local']);
    expect(inv._meta.hostvars['esx-01.bank.local']).toMatchObject({
      ansible_host: '192.0.2.10',
      openmap_id: HOST,
      openmap_site: 'HQ',
      openmap_type: 'host',
      openmap_attributes: { osName: 'ESXi' },
    });
  });

  it('groups by facet value under a parent group per facet, under all', () => {
    expect(inv['site_hq']).toEqual({ hosts: ['esx-01.bank.local'], vars: { openmap_site_code: 'HQ' } });
    expect(inv['type_vm']).toEqual({ hosts: ['ci-3'] });
    expect(inv['service_bs_payments']).toMatchObject({
      hosts: ['esx-01.bank.local'],
      vars: { openmap_service_id: SERVICE.id, openmap_service_name: 'Payments' },
    });
    expect(inv['openmap_site']).toEqual({ children: ['site_dr', 'site_hq'] });
    expect(inv['openmap_tag']).toEqual({ children: ['tag_hardware', 'tag_pci'] });
    expect(inv.all).toEqual({
      children: ['ungrouped', 'openmap_site', 'openmap_type', 'openmap_tag', 'openmap_service'],
    });
    expect(inv['ungrouped']).toEqual({ hosts: [] });
  });

  it('puts a host no facet groups in ungrouped', () => {
    const only = ansibleInventory(nodes, ['service']);
    expect(only['ungrouped']).toEqual({ hosts: ['ci-3'] });
    expect(only.all).toEqual({ children: ['ungrouped', 'openmap_service'] });
  });
});

describe('salt-ssh roster', () => {
  it('names the host, user, port and sudo of every minion and its facts as grains', () => {
    const roster = saltRoster(nodes, { user: 'ops', port: 2222, sudo: true });
    expect(saltRosterSchema.safeParse(roster).success).toBe(true);
    expect(roster['esx-01.bank.local']).toMatchObject({
      host: '192.0.2.10',
      user: 'ops',
      port: 2222,
      sudo: true,
    });
    expect(roster['esx-01.bank.local']?.minion_opts.grains[INVENTORY.prefix]).toMatchObject({
      id: HOST,
      site: 'HQ',
    });
    expect(saltRoster(nodes, {})['ci-3']).not.toHaveProperty('user');
  });
});

describe('Puppet ENC', () => {
  it('classifies from puppetClasses and takes the CI environment before the request before the default', () => {
    const [vm, esx] = nodes;
    if (vm === undefined || esx === undefined) throw new Error('two nodes expected');
    expect(puppetNode(esx, null)).toEqual({
      classes: { 'role::esx': {}, 'profile::base': {} },
      parameters: expect.objectContaining({ openmap_id: HOST, openmap_site: 'HQ' }) as unknown,
      environment: INVENTORY.puppetDefaultEnvironment,
    });
    expect(puppetNode(esx, 'qa').environment).toBe('qa');
    expect(puppetNode(vm, 'qa')).toMatchObject({ classes: {}, environment: 'staging' });
    expect(puppetNodesSchema.safeParse(puppetNodes(nodes, null)).success).toBe(true);
  });
});

describe('Chef export', () => {
  it('writes one role per site and service and puts the node in them', () => {
    const out = chefExport(nodes, null);
    expect(chefExportSchema.safeParse(out).success).toBe(true);
    expect(out.roles.map((r) => r.name)).toEqual([
      'openmap_service_bs_payments',
      'openmap_site_dr',
      'openmap_site_hq',
    ]);
    const esx = out.nodes.find((n) => n.name === 'esx-01.bank.local');
    expect(esx).toMatchObject({
      chef_environment: 'dc',
      run_list: ['role[openmap_site_hq]', 'role[openmap_service_bs_payments]'],
      normal: { openmap: { id: HOST } },
    });
    expect(out.nodes.find((n) => n.name === 'ci-3')?.chef_environment).toBe(INVENTORY.chefDefaultEnvironment);
    expect(chefExport(nodes, 'prod').nodes.find((n) => n.name === 'ci-3')?.chef_environment).toBe('prod');
  });
});
