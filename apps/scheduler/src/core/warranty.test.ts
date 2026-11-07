// T-356 REQ-CMDB-024 — warranty planning from the CMDB: manufacturers mapped to adapters, duplicates and serial-less or
// non-hardware rows dropped, vendors without a credential reported instead of planned, chunking, and the job options
// (vendor, endpoints, EoX for Cisco, the asset list) a valid collector job carries.
import { WARRANTY } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { planWarrantyJobs, warrantyVendorOf, type HardwareRow } from './warranty.js';

const endpoints = {
  dell: { apiUrl: 'https://dell.test', tokenUrl: 'https://dell.test/token' },
  lenovo: { apiUrl: 'https://lenovo.test' },
  cisco: { apiUrl: 'https://cisco.test', tokenUrl: 'https://cisco.test/token' },
};
const base = { tenantId: '00000000-0000-4000-8000-000000000001', nodeId: 'node-1', endpoints, now: '2026-11-07T08:00:00.000Z' };

describe('warranty planning', () => {
  it('maps manufacturers to adapters', () => {
    expect(warrantyVendorOf('Dell Technologies')).toBe('dell');
    expect(warrantyVendorOf('Dell Inc.')).toBe('dell');
    expect(warrantyVendorOf('LENOVO')).toBe('lenovo');
    expect(warrantyVendorOf('Cisco Systems')).toBe('cisco');
    expect(warrantyVendorOf('Hewlett Packard Enterprise')).toBeNull();
    expect(warrantyVendorOf(null)).toBeNull();
  });

  it('plans one job per vendor with a credential and reports the rest', () => {
    const rows: HardwareRow[] = [
      { ciType: 'host', name: 'esx-01', serialNumber: 'B2', manufacturer: 'Dell Technologies' },
      { ciType: 'host', name: 'esx-01-again', serialNumber: 'b2', manufacturer: 'Dell Inc.' },
      { ciType: 'host', name: 'esx-02', serialNumber: 'A1', manufacturer: 'Dell Technologies' },
      { ciType: 'network_device', name: 'dist-01', serialNumber: 'FOC1', manufacturer: 'Cisco Systems' },
      { ciType: 'host', name: 'sr650', serialNumber: 'J30', manufacturer: 'Lenovo' },
      { ciType: 'host', name: 'dl380', serialNumber: 'CZ1', manufacturer: 'Hewlett Packard Enterprise' },
      { ciType: 'host', name: 'no-serial', serialNumber: null, manufacturer: 'Dell Technologies' },
      { ciType: 'vm', name: 'vm-1', serialNumber: 'VM1', manufacturer: 'Dell Technologies' },
    ];
    const plan = planWarrantyJobs({ ...base, rows, credentialRefs: { dell: 'warranty/dell', cisco: 'warranty/cisco' } });
    expect(plan.planned).toEqual({ dell: 2, cisco: 1 });
    expect(plan.withoutCredential).toEqual({ lenovo: 1 });
    expect(plan.unsupported).toBe(1);
    expect(plan.jobs).toHaveLength(2);
    const [dell, cisco] = plan.jobs;
    expect(dell?.credentialType).toBe('oauth_client');
    expect(dell?.options).toMatchObject({ vendor: 'dell', apiUrl: 'https://dell.test', tokenUrl: 'https://dell.test/token' });
    expect(dell?.options['eox']).toBeUndefined();
    expect(dell?.options['assets']).toEqual([
      { serialNumber: 'A1', ciType: 'host', name: 'esx-02' },
      { serialNumber: 'B2', ciType: 'host', name: 'esx-01' },
    ]);
    expect(cisco?.options).toMatchObject({ vendor: 'cisco', eox: true });
    expect(cisco?.targets).toEqual([{ kind: 'account', value: 'https://cisco.test', label: 'cisco' }]);
  });

  it('chunks large fleets', () => {
    const rows: HardwareRow[] = Array.from({ length: WARRANTY.assetsPerJob + 1 }, (_, i) => ({
      ciType: 'host',
      name: 'h' + String(i),
      serialNumber: 'S' + String(i).padStart(4, '0'),
      manufacturer: 'Lenovo',
    }));
    const plan = planWarrantyJobs({ ...base, rows, credentialRefs: { lenovo: 'warranty/lenovo' }, options: { verifyTls: true } });
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[1]?.options['assets']).toHaveLength(1);
    expect(plan.jobs[0]?.options['verifyTls']).toBe(true);
    expect(plan.jobs[0]?.credentialType).toBe('api_token');
  });
});
