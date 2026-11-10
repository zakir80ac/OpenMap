// T-622 REQ-INT-011 (ADR-072) — the inventory routes in the REST contract:
// - the OpenAPI document lists the five routes under /api/v1/inventory, the roster and ENC routes answering YAML first;
// - the query schemas take comma lists, known facets only, and a roster port within the TCP range;
// - group names are what Ansible and Chef accept.
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { DEFAULT_INVENTORY_FACETS, INVENTORY_FACETS, inventoryGroupName } from './inventory.js';
import { openApiDocument, REST_ROUTES } from './rest.js';

type Paths = Record<string, Record<string, { operationId: string; responses: Record<string, { content?: Record<string, unknown> }> }>>;

describe('inventory routes', () => {
  const doc = openApiDocument(CONTRACT_VERSIONS.rest) as { info: { version: string }; paths: Paths };

  it('are in the OpenAPI document with the media types they answer', () => {
    expect(doc.info.version).toBe(CONTRACT_VERSIONS.rest);
    const media = (path: string): string[] => Object.keys(doc.paths[path]?.['get']?.responses['200']?.content ?? {});
    expect(media('/api/v1/inventory/ansible')).toEqual(['application/json']);
    expect(media('/api/v1/inventory/salt')).toEqual(['application/yaml', 'application/json']);
    expect(media('/api/v1/inventory/puppet')).toEqual(['application/yaml', 'application/json']);
    expect(media('/api/v1/inventory/puppet/nodes/{certname}')).toEqual(['application/yaml', 'application/json']);
    expect(media('/api/v1/inventory/chef')).toEqual(['application/json']);
    expect(doc.paths['/api/v1/inventory/puppet/nodes/{certname}']?.['get']?.operationId).toBe('puppetNode');
  });

  it('parse comma lists and known facets only', () => {
    const q = REST_ROUTES.ansibleInventory.query.parse({ types: 'host,vm', sites: 'HQ,DR', groupBy: 'site,service' });
    expect(q).toMatchObject({ types: ['host', 'vm'], sites: ['HQ', 'DR'], groupBy: ['site', 'service'] });
    expect(REST_ROUTES.ansibleInventory.query.safeParse({ groupBy: 'colour' }).success).toBe(false);
    expect(REST_ROUTES.ansibleInventory.query.safeParse({ types: 'teapot' }).success).toBe(false);
    expect(DEFAULT_INVENTORY_FACETS.every((f) => INVENTORY_FACETS.includes(f))).toBe(true);
  });

  it('bound the roster port and take a document format', () => {
    expect(REST_ROUTES.saltRoster.query.parse({ port: '2222', sudo: 'true', format: 'json' })).toMatchObject({ port: 2222, sudo: 'true', format: 'json' });
    expect(REST_ROUTES.saltRoster.query.safeParse({ port: '70000' }).success).toBe(false);
    expect(REST_ROUTES.puppetNode.query.safeParse({ format: 'xml' }).success).toBe(false);
  });

  it('name groups with letters, digits and underscores only', () => {
    expect(inventoryGroupName('site', 'HQ')).toBe('site_hq');
    expect(inventoryGroupName('service', '--BS.Payments--')).toBe('service_bs_payments');
    expect(inventoryGroupName('tag', 'إنتاج')).toMatch(/^tag_x[0-9a-f]+$/u);
  });
});
