// T-451 REQ-CORE-013 REQ-CORE-001 — the identity rules of ADR-045: issuer-scoped global keys and `*Ref` resolution.
import { describe, expect, it } from 'vitest';
import { CI_IDENTITY_KEYS, CI_TYPES, GLOBAL_IDENTITY_KEYS, GLOBAL_IDENTITY_SCOPES, IDENTITY_REF_TARGETS } from './ci.js';
import { globalMatches, identityKeysOf, MapRefIndex, refDepth, refKeyOf, refTokensOf } from './identity.js';

describe('identity rules (ADR-045)', () => {
  it('lists every reference key with the types it names', () => {
    for (const t of CI_TYPES) {
      for (const k of CI_IDENTITY_KEYS[t]) {
        if (!k.endsWith('Ref') || GLOBAL_IDENTITY_KEYS.has(k)) continue;
        expect(IDENTITY_REF_TARGETS[k], t + '.' + k).toBeDefined();
      }
    }
    for (const targets of Object.values(IDENTITY_REF_TARGETS)) for (const t of targets) expect(CI_TYPES).toContain(t);
  });

  it('declares a scope key on every type that carries a scoped global key', () => {
    for (const t of CI_TYPES) {
      for (const [key, scope] of Object.entries(GLOBAL_IDENTITY_SCOPES)) {
        if (!CI_IDENTITY_KEYS[t].includes(key)) continue;
        expect(scope.some((s) => CI_IDENTITY_KEYS[t].includes(s)), t + '.' + key).toBe(true);
      }
    }
  });

  it('scopes a SaaS tenant id by its vendor', () => {
    const now = { type: 'saas_tenant' as const, identity: { vendor: 'ServiceNow', tenantId: 'horizonbank' } };
    const workday = { type: 'saas_tenant' as const, identity: { vendor: 'Workday', tenantId: 'horizonbank' } };
    expect(globalMatches(now).map((g) => g.key)).toEqual(['saas_tenant|vendor=servicenow|tenantId=horizonbank']);
    expect(globalMatches(now)[0]?.values).toEqual({ vendor: 'ServiceNow', tenantId: 'horizonbank' });
    const keysA = new Set(identityKeysOf(now));
    expect(identityKeysOf(workday).some((k) => keysA.has(k))).toBe(false);
    // Without its vendor the id identifies through the tuple only.
    expect(globalMatches({ type: 'saas_tenant', identity: { tenantId: 'horizonbank' } })).toEqual([]);
  });

  it('does not match a namespace on its cluster UID alone', () => {
    expect(globalMatches({ type: 'k8s_namespace', identity: { clusterUid: 'c1', name: 'kube-system' } })).toEqual([]);
    const a = new Set(identityKeysOf({ type: 'k8s_namespace', identity: { clusterUid: 'c1', name: 'kube-system' } }));
    expect(identityKeysOf({ type: 'k8s_namespace', identity: { clusterUid: 'c1', name: 'monitoring' } }).some((k) => a.has(k))).toBe(false);
    expect(globalMatches({ type: 'k8s_cluster', identity: { clusterUid: 'c1' } })).toHaveLength(1);
  });

  it('scopes cloud ids by provider and cluster ids by platform or engine, and leaves unscoped keys alone', () => {
    expect(globalMatches({ type: 'cloud_resource', identity: { provider: 'gcp', resourceId: '1234' } })[0]?.key).toBe('cloud_resource|provider=gcp|resourceId=1234');
    expect(globalMatches({ type: 'database_cluster', identity: { engine: 'postgres', clusterId: 'main' } })[0]?.key).toBe('database_cluster|engine=postgres|clusterId=main');
    expect(globalMatches({ type: 'vm_cluster', identity: { platform: 'vmware', clusterId: 'vc:domain-c8' } })[0]?.key).toBe('vm_cluster|platform=vmware|clusterId=vc:domain-c8');
    expect(globalMatches({ type: 'host', identity: { serialNumber: 'ABC' } })[0]?.key).toBe('host|serialNumber=abc');
  });

  it('resolves a ref through any identity value, the name or an alias attribute of the CI it names', () => {
    const refs = new MapRefIndex();
    refs.add({ type: 'vm', identity: { instanceUuid: 'DC7A-1', fqdn: 'api-01.bank.local' }, name: 'api-01', attributes: { ipAddress: '10.36.0.10' } }, 'vm-1');
    refs.add({ type: 'network_device', identity: { serialNumber: 'FDO1' }, name: 'core-01', attributes: {} }, 'sw-1');
    expect(refs.resolve('hostRef', 'dc7a-1')).toBe('vm-1');
    expect(refs.resolve('hostRef', '10.36.0.10')).toBe('vm-1');
    expect(refs.resolve('hostRef', 'API-01.bank.local')).toBe('vm-1');
    expect(refs.resolve('hostRef', 'api-01')).toBe('vm-1');
    expect(refs.resolve('deviceRef', 'serial:FDO1')).toBe('sw-1');
    // A ref only names its target types.
    expect(refs.resolve('hostRef', 'serial:FDO1')).toBeUndefined();
    expect(refs.resolve('vrfRef', 'core-01')).toBeUndefined();
    const lb = { type: 'listening_service' as const, identity: { hostRef: '10.36.0.10', protocol: 'tcp', port: '8443' } };
    const agent = { type: 'listening_service' as const, identity: { hostRef: 'DC7A-1', protocol: 'tcp', port: '8443' } };
    expect(refKeyOf(lb, refs)).toBe('listening_service|ref=@vm-1|tcp|8443');
    expect(refKeyOf(agent, refs)).toBe(refKeyOf(lb, refs));
    expect(refKeyOf({ type: 'listening_service', identity: { hostRef: '10.9.9.9', protocol: 'tcp', port: '1' } }, refs)).toBeNull();
    expect(refKeyOf({ type: 'host', identity: { serialNumber: 'X' } }, refs)).toBeNull();
  });

  it('prefers an identity match over an alias, and resolves nothing when one rank names two CIs', () => {
    const refs = new MapRefIndex();
    refs.add({ type: 'host', identity: { serialNumber: 'S1' }, name: 'web-01', attributes: { primaryIp: '10.0.0.5' } }, 'h1');
    refs.add({ type: 'host', identity: { serialNumber: 'S2', fqdn: 'web-01' }, name: 'web-01b', attributes: { primaryIp: '10.0.0.5' } }, 'h2');
    expect(refs.resolve('hostRef', 'web-01')).toBe('h2');
    expect(refs.resolve('hostRef', '10.0.0.5')).toBeUndefined();
    // The order the CIs arrive in does not change the answer.
    const reversed = new MapRefIndex();
    reversed.add({ type: 'host', identity: { serialNumber: 'S2', fqdn: 'web-01' }, name: 'web-01b', attributes: { primaryIp: '10.0.0.5' } }, 'h2');
    reversed.add({ type: 'host', identity: { serialNumber: 'S1' }, name: 'web-01', attributes: { primaryIp: '10.0.0.5' } }, 'h1');
    expect(reversed.resolve('hostRef', 'web-01')).toBe('h2');
    expect(reversed.resolve('hostRef', '10.0.0.5')).toBeUndefined();
  });

  it('derives serial:<serial> and name@version tokens, and gives types no ref names none', () => {
    const tokens = refTokensOf({ type: 'software', identity: { vendor: 'Eclipse Adoptium', name: 'Temurin JDK', version: '21.0.4+7' }, name: 'Temurin JDK 21', attributes: {} }).map((t) => t.token);
    expect(tokens).toContain('temurin jdk@21.0.4+7');
    expect(refTokensOf({ type: 'listening_service', identity: { hostRef: 'h', protocol: 'tcp', port: '1' }, name: 'l', attributes: {} })).toEqual([]);
  });

  it('orders types by ref depth', () => {
    expect(refDepth('host')).toBe(0);
    expect(refDepth('hypervisor')).toBeGreaterThan(refDepth('host'));
    expect(refDepth('listening_service')).toBeGreaterThan(refDepth('host'));
    expect(refDepth('software_instance')).toBeGreaterThan(refDepth('software'));
  });
});
