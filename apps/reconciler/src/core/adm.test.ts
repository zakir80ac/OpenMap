// T-149 REQ-DEP-002 (ADR-029) — dependency derivation offline: a flow to a server with a matching listener becomes a
// client → listener dependency with the process named; a flow to a server with no listener on that port becomes a
// client → compute dependency at lower confidence; components on both sides become a component → component
// dependency, ambiguous (and less confident) when the client runs several; flows under the floor, self-flows and
// flows from unowned addresses derive nothing; the output is aggregated per edge and deterministic.
import { describe, expect, it } from 'vitest';
import { ADM } from '@openmap/constants';
import { deriveDependencies, type AdmInput, type FlowEdge } from './adm.js';

const AT = '2026-11-05T10:00:00.000Z';
const FROM = '2026-11-05T09:00:00.000Z';

function flow(fromId: string, toId: string, port: number, flows: number, extra: Partial<FlowEdge> = {}): FlowEdge {
  return { fromId, fromType: 'ip_address', toId, toType: 'ip_address', protocol: 'tcp', port, flows, bytes: flows * 1_000, packets: flows * 10, exporters: ['core-01'], firstSeen: FROM, lastSeen: AT, ...extra };
}

function input(flows: FlowEdge[], overrides: Partial<AdmInput> = {}): AdmInput {
  return {
    flows,
    addresses: new Map([
      ['ip-web', '10.0.1.10'],
      ['ip-api', '10.0.1.20'],
      ['ip-db', '10.0.1.30'],
      ['ip-stranger', '10.9.9.9'],
    ]),
    owners: new Map([
      ['ip-web', ['web-01']],
      ['ip-api', ['api-01']],
      ['ip-db', ['db-01']],
    ]),
    computeNames: new Map([
      ['web-01', 'web-01'],
      ['api-01', 'api-01'],
      ['db-01', 'db-01'],
    ]),
    listeners: [
      { id: 'lsn-api-8443', computeId: 'api-01', protocol: 'tcp', port: 8443, process: 'java' },
      { id: 'lsn-db-5432', computeId: 'db-01', protocol: 'tcp', port: 5432, process: 'postgres' },
    ],
    components: [
      { id: 'cmp-web', computeIds: ['web-01'], protocol: 'https', port: 443, application: 'banking' },
      { id: 'cmp-api', computeIds: ['api-01'], protocol: 'https', port: 8443, application: 'banking' },
      { id: 'cmp-db', computeIds: ['db-01'], protocol: 'tcp', port: 5432, application: 'banking' },
    ],
    ...overrides,
  };
}

describe('deriveDependencies', () => {
  it('maps a flow to a listener, names the process, and maps the components behind it', () => {
    const out = deriveDependencies(input([flow('ip-web', 'ip-api', 8443, 120), flow('ip-api', 'ip-db', 5432, 40)]));
    expect(out.map((d) => [d.fromId, d.toId, d.kind])).toEqual([
      ['api-01', 'lsn-db-5432', 'listener'],
      ['cmp-api', 'cmp-db', 'component'],
      ['cmp-web', 'cmp-api', 'component'],
      ['web-01', 'lsn-api-8443', 'listener'],
    ]);
    const webToApi = out.find((d) => d.fromId === 'web-01');
    expect(webToApi?.confidence).toBe(ADM.confidence.listener);
    expect(webToApi?.attributes).toMatchObject({
      derivedFrom: 'flows',
      kind: 'listener',
      protocol: 'tcp',
      ports: [8443],
      flows: 120,
      bytes: 120_000,
      exporters: ['core-01'],
      clientAddresses: ['10.0.1.10'],
      serverAddresses: ['10.0.1.20'],
      processes: ['java'],
      lastSeen: AT,
      firstSeen: FROM,
      ambiguous: false,
    });
    expect(out.find((d) => d.fromId === 'cmp-web')?.confidence).toBe(ADM.confidence.component);
  });

  it('accepts flows whose ends are already compute and listener CIs (an agent or the synthetic estate)', () => {
    const out = deriveDependencies(
      input([
        flow('web-01', 'lsn-api-8443', 8443, 300, { fromType: 'host', toType: 'listening_service' }),
        flow('api-01', 'db-01', 5432, 20, { fromType: 'vm', toType: 'host' }),
      ]),
    );
    expect(out.map((d) => [d.fromId, d.toId, d.kind])).toEqual([
      ['api-01', 'lsn-db-5432', 'listener'],
      ['cmp-api', 'cmp-db', 'component'],
      ['cmp-web', 'cmp-api', 'component'],
      ['web-01', 'lsn-api-8443', 'listener'],
    ]);
    expect(out.find((d) => d.fromId === 'web-01')?.attributes).toMatchObject({ clientAddresses: [], serverAddresses: [], processes: ['java'] });
  });

  it('falls back to the compute when no listener serves the port, at lower confidence', () => {
    const out = deriveDependencies(input([flow('ip-web', 'ip-api', 9999, 10)]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fromId: 'web-01', toId: 'api-01', kind: 'compute', confidence: ADM.confidence.compute });
    expect(out[0]?.attributes['ports']).toEqual([9999]);
  });

  it('aggregates several flows into one edge and marks ambiguous client components', () => {
    const base = input([flow('ip-web', 'ip-api', 8443, 5, { exporters: ['core-02'] }), flow('ip-web', 'ip-api', 8443, 7, { lastSeen: '2026-11-05T11:00:00.000Z' })]);
    base.components.push({ id: 'cmp-web-2', computeIds: ['web-01'], protocol: 'https', port: 443, application: 'banking' });
    const out = deriveDependencies(base);
    const edge = out.find((d) => d.kind === 'listener');
    expect(edge?.attributes).toMatchObject({ flows: 12, exporters: ['core-01', 'core-02'], lastSeen: '2026-11-05T11:00:00.000Z' });
    const components = out.filter((d) => d.kind === 'component');
    expect(components.map((d) => d.fromId).sort()).toEqual(['cmp-web', 'cmp-web-2']);
    expect(components.every((d) => d.confidence === ADM.confidence.ambiguousComponent && d.attributes['ambiguous'] === true)).toBe(true);
  });

  it('derives nothing from noise, self-flows or unowned addresses', () => {
    const out = deriveDependencies(
      input([
        flow('ip-web', 'ip-api', 8443, ADM.minFlows - 1),
        flow('ip-stranger', 'ip-api', 8443, 50),
        flow('ip-web', 'ip-web', 22, 50),
      ]),
    );
    expect(out).toEqual([]);
  });

  it('is deterministic whatever the input order', () => {
    const a = deriveDependencies(input([flow('ip-web', 'ip-api', 8443, 120), flow('ip-api', 'ip-db', 5432, 40)]));
    const b = deriveDependencies(input([flow('ip-api', 'ip-db', 5432, 40), flow('ip-web', 'ip-api', 8443, 120)]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
