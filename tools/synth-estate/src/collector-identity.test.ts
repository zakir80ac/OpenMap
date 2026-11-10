// T-450 REQ-QA-001 REQ-QA-005 — the synthetic estate identifies and links CIs the way the real collectors do, so a
// discovery run against the estate updates its CIs instead of adding second copies (measured in simulated mode,
// docs/evidence/simulated-mode.md). Each expectation names the collector whose convention it follows. The estate also
// holds every CI once: no two of its CIs merge under the reconciler's identity rules (REQ-CORE-013, ADR-045).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectorResultSchema,
  globalMatches,
  identityKeysOf,
  MapRefIndex,
  refKeyOf,
  refPairs,
  type CollectorResult,
  type ObservedCi,
} from '@openmap/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEstate } from './estate.js';
import { emitEstate, NDJSON_SUFFIX } from './emit.js';
import { awsArn } from './gen/cloud.js';

const SCALE = 0.01;
const SEED = 42;
/** The scale of the full estate (550k CIs) the reconciler budget is measured on. */
const FULL_SCALE = 1;

type Ref = { type: string; identity: Record<string, string> } | { id: string };

/** Identity key of a CI or of a relationship end; ends by stored id do not occur in collector results. */
function key(ref: Ref): string {
  if (!('identity' in ref)) return 'id|' + ref.id;
  return (
    ref.type +
    '|' +
    JSON.stringify(
      Object.keys(ref.identity)
        .sort()
        .map((k) => [k, ref.identity[k]]),
    )
  );
}

describe('synth-estate identities follow the collectors', () => {
  let dir: string;
  let cis: ObservedCi[] = [];
  let rels: CollectorResult['relationships'] = [];
  const byKey = new Map<string, ObservedCi>();
  const ofType = (type: string): ObservedCi[] => cis.filter((c) => c.type === type);
  const linked = (from: string, rel: string, to: string): Array<[ObservedCi, ObservedCi]> =>
    rels.flatMap((r) => {
      const a = byKey.get(key(r.from));
      const b = byKey.get(key(r.to));
      return r.type === rel && a?.type === from && b?.type === to ? [[a, b] as [ObservedCi, ObservedCi]] : [];
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'synth-identity-'));
    await emitEstate(buildEstate(SEED, SCALE), dir);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(NDJSON_SUFFIX))) {
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (line.length === 0) continue;
        const r = collectorResultSchema.parse(JSON.parse(line));
        cis.push(...r.cis);
        rels.push(...r.relationships);
      }
    }
    for (const c of cis) byKey.set(key(c), c);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    cis = [];
    rels = [];
  });

  it('points network-device children at the device as SNMP does (serial:<serial>)', () => {
    const children = [
      ...ofType('interface'),
      ...ofType('vlan'),
      ...ofType('vrf'),
      ...ofType('firewall_rule'),
      ...ofType('firewall_object'),
    ];
    expect(ofType('firewall_object').length).toBeGreaterThan(0);
    expect(children.length).toBeGreaterThan(0);
    const serials = new Set(
      [...ofType('network_device'), ...ofType('load_balancer')].map(
        (d) => 'serial:' + (d.identity['serialNumber'] ?? ''),
      ),
    );
    for (const c of children) expect(serials.has(c.identity['deviceRef'] ?? ''), c.name).toBe(true);
  });

  it('keys hypervisors, clusters and VMs as vCenter, Prism, Hyper-V and libvirt report them', () => {
    const hostedOn = linked('hypervisor', 'hosted_on', 'host');
    expect(hostedOn.length).toBe(ofType('hypervisor').length);
    for (const [hv, host] of hostedOn) expect(hv.identity['hostRef']).toBe(host.identity['fqdn']);
    for (const hv of ofType('hypervisor').filter((h) => h.identity['platform'] === 'vmware'))
      expect(hv.identity['moRef']).toMatch(/^vcenter-[a-z0-9-]+\.[a-z.]+:host-\d+$/);
    for (const cl of ofType('vm_cluster')) {
      const platform = cl.identity['platform'];
      if (platform === 'vmware') expect(cl.identity['clusterId']).toMatch(/:domain-c\d+$/);
      if (platform === 'nutanix_ahv' || platform === 'hyperv')
        expect(cl.identity['clusterId']).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    }
    const runsOn = linked('vm', 'runs_on', 'hypervisor');
    expect(runsOn.length).toBe(ofType('vm').filter((v) => v.identity['hypervisorRef'] !== undefined).length);
    for (const [vm, hv] of runsOn) expect(vm.identity['hypervisorRef']).toBe(hv.identity['hostRef']);
    expect(linked('hypervisor', 'runs_on', 'host')).toHaveLength(0);
    expect(linked('vm', 'hosted_on', 'hypervisor')).toHaveLength(0);
  });

  it('installs operating systems on hosts and versions Windows by its build (WMI)', () => {
    const os = ofType('operating_system');
    expect(linked('operating_system', 'installed_on', 'host').length).toBe(os.length);
    for (const o of os.filter((x) => x.identity['family'] === 'windows'))
      expect(o.identity['version']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names installed software name@version and links it to its software (SSH, WMI, agent)', () => {
    const members = linked('software_instance', 'member_of', 'software');
    expect(members.length).toBe(ofType('software_instance').length);
    for (const [inst, sw] of members)
      expect(inst.identity['softwareRef']).toBe(
        String(sw.identity['name']) + '@' + String(sw.identity['version']),
      );
  });

  it('writes CNAME targets absolute, LUN WWNs with the array OUI and ARNs in each service form', () => {
    for (const r of ofType('dns_record').filter((x) => x.identity['recordType'] === 'CNAME'))
      expect(r.identity['value']).toMatch(/\.$/);
    for (const l of ofType('lun')) expect(l.identity['wwn']).toMatch(/^naa\.6[0-9a-f]{31}$/);
    const aws = ofType('cloud_resource').filter((x) => x.identity['provider'] === 'aws');
    expect(aws.length).toBeGreaterThan(0);
    for (const r of aws) expect(r.identity['resourceId']).toMatch(/^arn:aws:[a-z0-9]+:[a-z0-9-]+:\d{12}:/);
    expect(awsArn('AWS::RDS::DBInstance', 'me-south-1', '123456789012', 'orders')).toBe(
      'arn:aws:rds:me-south-1:123456789012:db:orders',
    );
    expect(awsArn('AWS::Lambda::Function', 'me-south-1', '123456789012', 'fn')).toBe(
      'arn:aws:lambda:me-south-1:123456789012:function:fn',
    );
    expect(awsArn('AWS::EC2::Instance', 'me-south-1', '123456789012', 'i-1')).toBe(
      'arn:aws:ec2:me-south-1:123456789012:instance/i-1',
    );
  });

  it('names each fabric by its principal switch (Brocade fabricshow, MDS fcdomain)', () => {
    const wwnns = new Set(ofType('fc_switch').map((s) => s.identity['wwnn']));
    expect(ofType('fc_fabric').length).toBeGreaterThan(0);
    for (const f of ofType('fc_fabric')) expect(wwnns.has(f.identity['fabricWwn'])).toBe(true);
  });

  it('issues SaaS tenant ids in each vendor shape and names products as the vendor API reports them', () => {
    const tenants = new Map(
      ofType('saas_tenant').map((t) => [t.identity['vendor'], t.identity['tenantId'] ?? '']),
    );
    expect(tenants.get('Microsoft')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(tenants.get('Google')).toMatch(/^C0[a-z0-9]{7}$/);
    expect(tenants.get('Salesforce')).toMatch(/^00D[A-Za-z0-9]{15}$/);
    const products = new Set(ofType('saas_application').map((a) => a.identity['product']));
    for (const p of ['SPE_E3', 'Google Workspace', 'Workday HCM']) expect(products.has(p), p).toBe(true);
  });

  it('holds every CI once: no two estate CIs share a tuple, a resolved ref key or a scoped global key', () => {
    const refs = new MapRefIndex();
    cis.forEach((c, i) => refs.add(c, String(i)));
    const owner = new Map<string, number>();
    const merges: string[] = [];
    cis.forEach((c, i) => {
      const refKey = refPairs(c).length > 0 ? refKeyOf(c, refs) : null;
      for (const k of identityKeysOf(c, refKey)) {
        const o = owner.get(k);
        const other = o === undefined ? undefined : cis[o];
        if (other !== undefined && o !== i && key(other) !== key(c)) {
          merges.push(c.type + ' ' + other.name + ' | ' + c.name + ' (' + k + ')');
          break;
        }
        owner.set(k, i);
      }
    });
    expect(merges.slice(0, 10)).toEqual([]);
    // The two estate tenants named horizonbank, at ServiceNow and at Workday, stay two CIs.
    expect(
      ofType('saas_tenant')
        .filter((t) => t.identity['tenantId'] === 'horizonbank')
        .map((t) => t.identity['vendor'])
        .sort(),
    ).toEqual(['ServiceNow', 'Workday']);
  });

  it('at full scale (the scale-1 replay), reports no CI twice in one result and gives no two CIs one global key', () => {
    const estate = buildEstate(SEED, FULL_SCALE);
    const seen = new Map<string, string>();
    const owner = new Map<string, { name: string; key: string }>();
    const twice: string[] = [];
    const shared: string[] = [];
    for (const c of estate.builder.cis) {
      const k = String(c.slot) + '|' + key(c);
      const first = seen.get(k);
      if (first !== undefined) twice.push(c.type + ' ' + first + ' | ' + c.name);
      else seen.set(k, c.name);
      // One CI reported by two collectors (the vendor Microsoft) has one identity; two CIs never share a global key.
      for (const g of globalMatches(c)) {
        const o = owner.get(g.key);
        if (o === undefined) owner.set(g.key, { name: c.name, key: key(c) });
        else if (o.key !== key(c)) shared.push(g.key + ' ' + o.name + ' | ' + c.name);
      }
    }
    expect(twice.slice(0, 10)).toEqual([]);
    expect(shared.slice(0, 10)).toEqual([]);
  });
});
