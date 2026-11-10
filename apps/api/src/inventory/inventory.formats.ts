// REQ-INT-011 (ADR-072) — OpenMap nodes in each configuration-management tool's own format. Pure, so every format is
// unit-tested: the Ansible dynamic-inventory JSON (`_meta.hostvars`, a group per facet value under a parent group per
// facet), the salt-ssh flat roster (facts as grains), the Puppet ENC document (classes from the CI's puppetClasses
// attribute, OpenMap facts as top-scope parameters) and the Chef node and role JSON `knife node|role from file` loads.
import { INVENTORY } from '@openmap/constants';
import {
  inventoryGroupName,
  type AnsibleGroup,
  type AnsibleInventory,
  type ChefExport,
  type ChefNode,
  type ChefRole,
  type InventoryFacet,
  type InventoryFacts,
  type PuppetNode,
  type SaltRoster,
} from '@openmap/contracts';

export type VarValue = InventoryFacts['attributes'][string];

/** One node as a tool sees it: the name it is known by, where to connect, OpenMap's facts and the tool settings read from the CI. */
export interface InventoryNode {
  name: string;
  /** Management IP or FQDN (INVENTORY.addressKeys); null when the CI reports none, and the tool resolves the name. */
  address: string | null;
  facts: InventoryFacts;
  /** Attributes that steer a tool rather than describe the node (puppetClasses, puppetEnvironment, chefEnvironment). */
  settings: Readonly<Record<string, VarValue>>;
}

const P = INVENTORY.prefix;

/** The facts as `openmap_<name>` variables, the flat form Ansible hostvars and Puppet top-scope parameters use. */
export function prefixedFacts(facts: InventoryFacts): Record<string, unknown> {
  return {
    [P + '_id']: facts.id,
    [P + '_merged_ids']: facts.mergedIds,
    [P + '_code']: facts.code,
    [P + '_name']: facts.name,
    [P + '_type']: facts.type,
    [P + '_layer']: facts.layer,
    [P + '_lifecycle']: facts.lifecycle,
    [P + '_site']: facts.site,
    [P + '_tags']: facts.tags,
    [P + '_services']: facts.services,
    [P + '_attributes']: facts.attributes,
  };
}

/** The values a node has for a facet; a node has no site group when no site is known. */
function facetValues(
  node: InventoryNode,
  facet: InventoryFacet,
): Array<{ group: string; vars?: Record<string, unknown> }> {
  const f = node.facts;
  switch (facet) {
    case 'site':
      return f.site === null
        ? []
        : [{ group: inventoryGroupName('site', f.site), vars: { [P + '_site_code']: f.site } }];
    case 'type':
      return [{ group: inventoryGroupName('type', f.type) }];
    case 'layer':
      return [{ group: inventoryGroupName('layer', f.layer) }];
    case 'lifecycle':
      return [{ group: inventoryGroupName('lifecycle', f.lifecycle) }];
    case 'tag':
      return f.tags.map((t) => ({ group: inventoryGroupName('tag', t) }));
    case 'service':
      return f.services.map((s) => ({
        group: inventoryGroupName('service', s.code),
        vars: { [P + '_service_id']: s.id, [P + '_service_code']: s.code, [P + '_service_name']: s.name },
      }));
  }
}

/**
 * The JSON `ansible-inventory` reads from a dynamic-inventory script's `--list`: every host's vars under `_meta.hostvars`
 * (so Ansible never calls `--host`), a group per facet value (`site_hq`, `type_vm`, `tag_pci`, `service_bs_payments`),
 * each under a parent group per facet (`openmap_site`, …), the parents under `all`, and hosts in no group in `ungrouped`.
 */
export function ansibleInventory(
  nodes: readonly InventoryNode[],
  facets: readonly InventoryFacet[],
): AnsibleInventory {
  const hostvars: Record<string, Record<string, unknown>> = {};
  const groups = new Map<string, { hosts: Set<string>; vars?: Record<string, unknown> }>();
  const parents = new Map<InventoryFacet, Set<string>>();
  const ungrouped: string[] = [];
  for (const node of nodes) {
    hostvars[node.name] = {
      ...(node.address === null ? {} : { ansible_host: node.address }),
      ...prefixedFacts(node.facts),
    };
    let grouped = false;
    for (const facet of facets) {
      for (const { group, vars } of facetValues(node, facet)) {
        const entry = groups.get(group) ?? {
          hosts: new Set<string>(),
          ...(vars === undefined ? {} : { vars }),
        };
        entry.hosts.add(node.name);
        groups.set(group, entry);
        const children = parents.get(facet) ?? new Set<string>();
        children.add(group);
        parents.set(facet, children);
        grouped = true;
      }
    }
    if (!grouped) ungrouped.push(node.name);
  }
  const out: Record<string, AnsibleGroup> = {};
  const top: string[] = ['ungrouped'];
  for (const facet of facets) {
    const children = parents.get(facet);
    if (children === undefined) continue;
    const parent = P + '_' + facet;
    top.push(parent);
    out[parent] = { children: [...children].sort() };
  }
  for (const [name, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
    out[name] = { hosts: [...g.hosts], ...(g.vars === undefined ? {} : { vars: g.vars }) };
  out['ungrouped'] = { hosts: ungrouped };
  return { _meta: { hostvars }, ...out, all: { children: top } };
}

/** The facts as one nested value, the form Salt grains and Chef attributes use. */
function nestedFacts(facts: InventoryFacts): Record<string, unknown> {
  return { ...facts };
}

export interface SaltOptions {
  user?: string;
  port?: number;
  sudo?: boolean;
}

/** A salt-ssh flat roster: minion id → host to connect to, the requested user/port/sudo, OpenMap facts as the `openmap` grain. */
export function saltRoster(nodes: readonly InventoryNode[], options: SaltOptions): SaltRoster {
  const roster: SaltRoster = {};
  for (const node of nodes) {
    roster[node.name] = {
      host: node.address ?? node.name,
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
      minion_opts: { grains: { [P]: nestedFacts(node.facts) } },
    };
  }
  return roster;
}

/** A setting as a list of names: an array of strings, or one comma-separated string. */
export function nameList(value: VarValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function textSetting(value: VarValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The Puppet ENC document of a node: its classes (each with no parameters) from the CI's `puppetClasses` attribute, the
 * OpenMap facts as top-scope `$openmap_*` parameters, and the environment the CI names, else the request's, else Puppet's default.
 */
export function puppetNode(node: InventoryNode, environment: string | null): PuppetNode {
  const classes: Record<string, Record<string, unknown>> = {};
  for (const c of nameList(node.settings[INVENTORY.puppetClassesAttribute])) classes[c] = {};
  return {
    classes,
    parameters: prefixedFacts(node.facts),
    environment:
      textSetting(node.settings[INVENTORY.puppetEnvironmentAttribute]) ??
      environment ??
      INVENTORY.puppetDefaultEnvironment,
  };
}

export function puppetNodes(
  nodes: readonly InventoryNode[],
  environment: string | null,
): { nodes: Record<string, PuppetNode> } {
  const out: Record<string, PuppetNode> = {};
  for (const node of nodes) out[node.name] = puppetNode(node, environment);
  return { nodes: out };
}

/** The roles a node is put in: one per site and one per business service, named like the Ansible groups with the prefix. */
function chefRoles(node: InventoryNode): ChefRole[] {
  const f = node.facts;
  const roles: ChefRole[] = [];
  const role = (name: string, description: string, attributes: Record<string, unknown>): ChefRole => ({
    name: P + '_' + name,
    chef_type: 'role',
    json_class: 'Chef::Role',
    description,
    run_list: [],
    env_run_lists: {},
    default_attributes: { [P]: attributes },
    override_attributes: {},
  });
  if (f.site !== null)
    roles.push(role(inventoryGroupName('site', f.site), 'OpenMap site ' + f.site, { site: f.site }));
  for (const s of f.services)
    roles.push(
      role(
        inventoryGroupName('service', s.code),
        'OpenMap business service ' + s.name + ' (' + s.code + ')',
        { service: s },
      ),
    );
  return roles;
}

/**
 * Chef node JSON (`knife node from file`) with OpenMap's facts under `normal.openmap` and the node's site and service
 * roles in its run list, and those roles (`knife role from file`), each once, with an empty run list of their own.
 */
export function chefExport(nodes: readonly InventoryNode[], environment: string | null): ChefExport {
  const roles = new Map<string, ChefRole>();
  const out: ChefNode[] = nodes.map((node) => {
    const own = chefRoles(node);
    for (const r of own) roles.set(r.name, r);
    return {
      name: node.name,
      chef_type: 'node',
      json_class: 'Chef::Node',
      chef_environment:
        textSetting(node.settings[INVENTORY.chefEnvironmentAttribute]) ??
        environment ??
        INVENTORY.chefDefaultEnvironment,
      run_list: own.map((r) => 'role[' + r.name + ']'),
      normal: { [P]: nestedFacts(node.facts) },
      default: {},
      override: {},
      automatic: {},
    };
  });
  return { nodes: out, roles: [...roles.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
