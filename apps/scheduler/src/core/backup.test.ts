// T-658 REQ-INT-017 (ADR-075) — backup-awareness planning: one job per backup server with the vendor's credential type
// and the CMDB inventory of VMs and hosts, valid against the collector job contract.
import { describe, expect, it } from 'vitest';
import { BACKUP_AWARENESS, CONTRACT_VERSIONS } from '@openmap/constants';
import { backupInventoryEntrySchema, collectorJobSchema } from '@openmap/contracts';
import { backupInventory, planBackupJobs, vendorPair } from './backup.js';

const TENANT = '7b0c4c34-7d1e-4f6a-9d38-0b9e0f7b2a11';
const rows = [
  {
    type: 'vm',
    name: 'pay-vm-01',
    identity: { instanceUuid: '5035a1b2-0c3d-4e5f-8a9b-0c1d2e3f4a5b', hypervisorRef: 'esx-01', fqdn: 'pay-vm-01.corp.example' },
    attributes: { vcenter: 'vc01.corp.example', moRef: 'vm-1033', ipAddress: '10.1.2.3' },
  },
  { type: 'host', name: 'db-01', identity: { serialNumber: 'CZ1234' }, attributes: { fqdn: 'db-01.corp.example' } },
  { type: 'database', name: 'ledger', identity: { hostRef: 'db-01', engine: 'sqlserver', name: 'ledger', port: '1433' }, attributes: {} },
  { type: 'vm', name: 'orphan', identity: {}, attributes: {} },
];

describe('backup planning', () => {
  it('keeps VMs and hosts with an identity, each with its match keys', () => {
    const inventory = backupInventory(rows);
    expect(inventory.map((e) => e.type).sort()).toEqual(['host', 'vm']);
    for (const e of inventory) expect(backupInventoryEntrySchema.safeParse(e).success).toBe(true);
    const vm = inventory.find((e) => e.type === 'vm');
    expect(vm?.identity['instanceUuid']).toBe('5035a1b2-0c3d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(vm?.keys).toContain('vc01.corp.example:vm-1033');
    expect(inventory.find((e) => e.type === 'host')?.keys).toEqual(expect.arrayContaining(['db-01', 'cz1234', 'db-01.corp.example']));
  });

  it('plans one contract-valid job per server with the vendor and the inventory', () => {
    const jobs = planBackupJobs({
      tenantId: TENANT,
      nodeId: 'node-01',
      servers: [
        { vendor: 'veeam', url: 'https://vbr.corp.example:9419', credentialRef: 'backup/veeam' },
        { vendor: 'rubrik', url: 'rubrik.corp.example', credentialRef: 'backup/rubrik' },
      ],
      rows,
      options: { verifyTls: true },
      now: '2026-11-10T12:00:00.000Z',
    });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(collectorJobSchema.safeParse(job).success).toBe(true);
    expect(jobs.map((j) => [j.collectorId, j.credentialType, j.options['vendor'], j.targets[0]?.kind])).toEqual([
      [BACKUP_AWARENESS.collectorId, 'password', 'veeam', 'host'],
      [BACKUP_AWARENESS.collectorId, 'oauth_client', 'rubrik', 'host'],
    ]);
    expect((jobs[0]?.options['inventory'] as unknown[]).length).toBe(2);
    expect(jobs[0]?.options['verifyTls']).toBe(true);
    expect(jobs[0]?.contractVersion).toBe(CONTRACT_VERSIONS.collector);
  });

  it('reads vendor pairs and refuses an unknown vendor', () => {
    expect(vendorPair('Commvault=https://cs.corp.example')).toEqual({ vendor: 'commvault', value: 'https://cs.corp.example' });
    expect(() => vendorPair('netbackup=x')).toThrow();
    expect(() => vendorPair('veeam=')).toThrow();
  });
});
