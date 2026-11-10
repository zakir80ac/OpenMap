// REQ-INT-011 (ADR-072) — dynamic inventory for configuration-management tools: the shapes OpenMap answers each tool
// with, in the tool's own format. Ansible reads the JSON a dynamic-inventory script prints (`_meta.hostvars` and groups),
// salt-ssh a flat roster, Puppet an external node classifier's document per certname, Chef the node and role JSON
// `knife node|role from file` loads. Version: CONTRACT_VERSIONS.rest (the routes live in rest.ts).
import { z } from 'zod';

/** What an Ansible group can be made from; each facet yields groups named `<facet>_<value>`. */
export const INVENTORY_FACETS = ['site', 'type', 'layer', 'tag', 'service', 'lifecycle'] as const;
export const inventoryFacetSchema = z.enum(INVENTORY_FACETS);
export type InventoryFacet = z.infer<typeof inventoryFacetSchema>;

/** Facets Ansible groups by when the request names none. */
export const DEFAULT_INVENTORY_FACETS: readonly InventoryFacet[] = ['site', 'type', 'tag', 'service'];

/** Document formats of the routes that answer YAML by default (Salt roster, Puppet ENC); JSON on request. */
export const INVENTORY_DOCUMENT_FORMATS = ['yaml', 'json'] as const;
export const inventoryDocumentFormatSchema = z.enum(INVENTORY_DOCUMENT_FORMATS);
export type InventoryDocumentFormat = z.infer<typeof inventoryDocumentFormatSchema>;

export const INVENTORY_MEDIA_TYPES: Record<InventoryDocumentFormat, string> = {
  yaml: 'application/yaml',
  json: 'application/json',
};

/** A value copied from a CI attribute: JSON scalars and arrays of them, as the CI contract stores attributes. */
const varValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]);

/** A business service a node serves, as every format names it. */
export const inventoryServiceSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });

/** OpenMap's facts about a node, the same in every tool (prefixed `openmap_` in Ansible and Puppet, nested under `openmap` in Salt and Chef). */
export const inventoryFactsSchema = z.object({
  id: z.uuid(),
  /** Ids of the other CIs that name the same node (a host and its hypervisor share an FQDN); they are one node to a tool. */
  mergedIds: z.array(z.uuid()),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  layer: z.string(),
  lifecycle: z.string(),
  site: z.string().nullable(),
  tags: z.array(z.string()),
  services: z.array(inventoryServiceSchema),
  attributes: z.record(z.string(), varValue),
});
export type InventoryFacts = z.infer<typeof inventoryFactsSchema>;

const ansibleGroupSchema = z.object({
  hosts: z.array(z.string()).optional(),
  children: z.array(z.string()).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
});
export type AnsibleGroup = z.infer<typeof ansibleGroupSchema>;

/** The JSON an Ansible dynamic-inventory script prints for `--list`: groups at the top level and every host's vars under `_meta`. */
export const ansibleInventorySchema = z
  .object({
    _meta: z.object({ hostvars: z.record(z.string(), z.record(z.string(), z.unknown())) }),
    all: ansibleGroupSchema,
  })
  .catchall(ansibleGroupSchema);
/** The same document as a TypeScript type: every key but `_meta` is a group. */
export interface AnsibleInventory {
  _meta: { hostvars: Record<string, Record<string, unknown>> };
  all: AnsibleGroup;
  [group: string]: AnsibleGroup | { hostvars: Record<string, Record<string, unknown>> };
}

/** One salt-ssh roster target: where to connect and, under `minion_opts.grains`, OpenMap's facts as grains. */
export const saltRosterEntrySchema = z.object({
  host: z.string(),
  user: z.string().optional(),
  port: z.number().int().optional(),
  sudo: z.boolean().optional(),
  minion_opts: z.object({ grains: z.record(z.string(), z.unknown()) }),
});
export const saltRosterSchema = z.record(z.string(), saltRosterEntrySchema);
export type SaltRoster = z.infer<typeof saltRosterSchema>;

/** A Puppet ENC document: classes (each with its parameters), top-scope parameters and the environment. */
export const puppetNodeSchema = z.object({
  classes: z.record(z.string(), z.record(z.string(), z.unknown())),
  parameters: z.record(z.string(), z.unknown()),
  environment: z.string(),
});
export type PuppetNode = z.infer<typeof puppetNodeSchema>;
export const puppetNodesSchema = z.object({ nodes: z.record(z.string(), puppetNodeSchema) });

/** A Chef node as `knife node from file` loads it (Chef::Node JSON). */
export const chefNodeSchema = z.object({
  name: z.string(),
  chef_type: z.literal('node'),
  json_class: z.literal('Chef::Node'),
  chef_environment: z.string(),
  run_list: z.array(z.string()),
  normal: z.record(z.string(), z.unknown()),
  default: z.record(z.string(), z.unknown()),
  override: z.record(z.string(), z.unknown()),
  automatic: z.record(z.string(), z.unknown()),
});
/** A Chef role as `knife role from file` loads it (Chef::Role JSON). */
export const chefRoleSchema = z.object({
  name: z.string(),
  chef_type: z.literal('role'),
  json_class: z.literal('Chef::Role'),
  description: z.string(),
  run_list: z.array(z.string()),
  env_run_lists: z.record(z.string(), z.array(z.string())),
  default_attributes: z.record(z.string(), z.unknown()),
  override_attributes: z.record(z.string(), z.unknown()),
});
export const chefExportSchema = z.object({ nodes: z.array(chefNodeSchema), roles: z.array(chefRoleSchema) });
export type ChefNode = z.infer<typeof chefNodeSchema>;
export type ChefRole = z.infer<typeof chefRoleSchema>;
export type ChefExport = z.infer<typeof chefExportSchema>;

/**
 * A group, role or grain name from a facet value: lower case, every run of characters other than letters, digits and
 * underscores folded to one underscore. Ansible group names and Chef role names accept exactly these. A value with no
 * such character at all (an Arabic tag) is written as `x` and the hex of its UTF-8 bytes, so two of them never merge.
 */
export function inventoryGroupName(facet: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (slug !== '') return facet + '_' + slug;
  const hex = [...new TextEncoder().encode(value)].map((b) => b.toString(HEX_RADIX).padStart(2, '0')).join('');
  return facet + '_x' + hex;
}

const HEX_RADIX = 16;
