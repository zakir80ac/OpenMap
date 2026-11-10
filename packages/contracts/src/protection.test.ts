// T-650 REQ-INT-017 (ADR-075) — the protection judgement, inventory keys and the backup_policy CI type in the contract.
import { describe, expect, it } from 'vitest';
import { BACKUP_AWARENESS } from '@openmap/constants';
import { CI_IDENTITY_KEYS, CI_TYPE_LAYER, observedCiSchema } from './ci.js';
import { collectorManifestSchema } from './collector.js';
import { backupInventoryEntrySchema, coversDatabases, inventoryKeysOf, judgeProtection, vcenterObjectKey } from './protection.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

describe('judgeProtection', () => {
  it('calls a CI without covers unprotected and judges it against the default RPO', () => {
    expect(judgeProtection([], [], NOW)).toEqual({
      state: 'unprotected',
      lastGoodBackupAt: null,
      policyRpoMinutes: null,
      targetRpoMinutes: BACKUP_AWARENESS.defaultRpoMinutes,
      ageMinutes: null,
    });
  });

  it('takes the newest good backup and the strictest of the policy and service RPOs', () => {
    const j = judgeProtection(
      [
        { lastGoodBackupAt: minutesAgo(300), rpoMinutes: 1440 },
        { lastGoodBackupAt: minutesAgo(45), rpoMinutes: 240 },
      ],
      [60, null],
      NOW,
    );
    expect(j).toEqual({ state: 'protected', lastGoodBackupAt: minutesAgo(45), policyRpoMinutes: 240, targetRpoMinutes: 60, ageMinutes: 45 });
  });

  it('breaches the RPO when the newest backup is older than the target, or when there is none', () => {
    expect(judgeProtection([{ lastGoodBackupAt: minutesAgo(61), rpoMinutes: null }], [60], NOW).state).toBe('rpo_breached');
    expect(judgeProtection([{ lastGoodBackupAt: minutesAgo(60), rpoMinutes: null }], [60], NOW).state).toBe('protected');
    const never = judgeProtection([{ lastGoodBackupAt: null, rpoMinutes: 240 }], [], NOW);
    expect(never).toMatchObject({ state: 'rpo_breached', ageMinutes: null, targetRpoMinutes: 240 });
    expect(judgeProtection([{ lastGoodBackupAt: 'not a date', rpoMinutes: 0 }], [], NOW).state).toBe('rpo_breached');
  });
});

describe('inventory keys', () => {
  it('names a VM by name, FQDN, address, instance UUID and vCenter moRef, in lower case', () => {
    const keys = inventoryKeysOf(
      'PAY-VM-01',
      { instanceUuid: '5035A1B2-0000-4E5F-8A9B-0C1D2E3F4A5B', fqdn: 'pay-vm-01.corp.example' },
      { ipAddress: '10.1.2.3', vcenter: 'VC01.corp.example', moRef: 'vm-1033', hostname: 'pay-vm-01' },
    );
    expect(keys).toEqual(
      expect.arrayContaining(['pay-vm-01', 'pay-vm-01.corp.example', '10.1.2.3', '5035a1b2-0000-4e5f-8a9b-0c1d2e3f4a5b', 'vc01.corp.example:vm-1033']),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(vcenterObjectKey(' VC01 ', 'vm-7 ')).toBe('vc01:vm-7');
    expect(backupInventoryEntrySchema.safeParse({ type: 'vm', identity: { fqdn: 'a.b' }, keys }).success).toBe(true);
    expect(backupInventoryEntrySchema.safeParse({ type: 'switch', identity: {}, keys }).success).toBe(false);
  });

  it('counts only database agents as application-aware', () => {
    expect(coversDatabases(['File System', 'sql server'])).toBe(true);
    expect(coversDatabases(['File System'])).toBe(false);
  });
});

describe('backup_policy and the backup family', () => {
  it('is a storage-layer CI identified by vendor, server and policy, emitted by a backup collector', () => {
    expect(CI_TYPE_LAYER.backup_policy).toBe('storage');
    expect(CI_IDENTITY_KEYS.backup_policy).toEqual(['vendor', 'serverId', 'policyId']);
    expect(
      observedCiSchema.safeParse({
        type: 'backup_policy',
        identity: { vendor: 'rubrik', serverId: 'cluster-1', policyId: 'gold' },
        name: 'Gold',
        attributes: { rpoMinutes: 240, unmatchedNames: ['a', 'b'] },
        tags: ['backup', 'rubrik'],
        externalIds: [{ source: 'rubrik', id: 'gold' }],
        observedAt: NOW.toISOString(),
      }).success,
    ).toBe(true);
    expect(
      collectorManifestSchema.safeParse({
        id: 'backup',
        family: 'backup',
        version: '0.1.0',
        language: 'go',
        protocols: ['https'],
        credentialTypes: ['password', 'oauth_client'],
        targetKinds: ['host'],
        emits: ['backup_policy'],
        contractVersion: '0.14.0',
      }).success,
    ).toBe(true);
  });
});
