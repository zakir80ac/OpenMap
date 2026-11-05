// T-169 REQ-CMDB-033 REQ-CMDB-036 — the import contract offline: the CSV reader handles quotes, doubled quotes, line
// breaks inside a field, CR LF and a BOM; a ServiceNow export is recognised and mapped (class names to CI types, sys_id
// as an external id); a generic sheet is mapped by its headers; rows become observations or are rejected with a reason
// (no type, unknown type, no name, no identity key of the type); a name-identified type takes its name as identity.
import { describe, expect, it } from 'vitest';
import { attributeKey, csvField, parseCsv, readImport, suggestMapping } from './import.js';

const AT = '2026-11-05T10:00:00.000Z';

describe('import contract', () => {
  it('reads RFC 4180 CSV and writes fields back', () => {
    expect(parseCsv('﻿name,notes\r\n"srv, one","said ""hi""\nthen left"\r\nsrv-2,\n')).toEqual([
      ['name', 'notes'],
      ['srv, one', 'said "hi"\nthen left'],
      ['srv-2', ''],
    ]);
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField('plain')).toBe('plain');
  });

  it('recognises a ServiceNow export and maps its classes', () => {
    const rows = parseCsv(
      'sys_id,sys_class_name,name,serial_number,ip_address,os\n' +
        'a1,cmdb_ci_linux_server,srv-ryd-01,SN-1,10.0.0.5,Red Hat Enterprise Linux 9\n' +
        'a2,cmdb_ci_appl,Core Banking,,,\n' +
        'a3,cmdb_ci_printer,Printer 7,PR-7,,\n' +
        'a4,cmdb_ci_linux_server,,SN-4,,\n' +
        'a5,cmdb_ci_win_server,srv-ryd-05,,,\n',
    );
    const mapping = suggestMapping(rows[0] ?? []);
    expect(mapping.columns['sys_id']).toBe('external.servicenow');
    const read = readImport(rows, mapping, AT);
    expect(read.observations).toHaveLength(2);
    expect(read.observations[0]).toMatchObject({ type: 'host', name: 'srv-ryd-01', identity: { serialNumber: 'SN-1' }, attributes: { primaryIp: '10.0.0.5', osName: 'Red Hat Enterprise Linux 9' }, externalIds: [{ source: 'servicenow', id: 'a1' }], observedAt: AT });
    expect(read.observations[1]).toMatchObject({ type: 'application', name: 'Core Banking', identity: { name: 'Core Banking' } });
    expect(read.rejected).toEqual([
      { row: 3, reason: 'unknown type cmdb_ci_printer' },
      { row: 4, reason: 'no name' },
      { row: 5, reason: 'no identity key of host (serialNumber, systemUuid, fqdn, primaryMac)' },
    ]);
    expect(read.byType).toEqual({ host: 1, application: 1 });
  });

  it('maps a generic sheet by its headers and uses the default type', () => {
    const rows = parseCsv('Name,Serial Number,Purchase date,Tags,FQDN\nsrv-9,SN-9,2024-03-01,pci;prod; ,srv-9.bank.local\n');
    const mapping = suggestMapping(rows[0] ?? []);
    expect(mapping.columns).toEqual({ Name: 'name', 'Serial Number': 'identity.serialNumber', 'Purchase date': 'attribute.purchaseDate', Tags: 'tags', FQDN: 'identity.fqdn' });
    const read = readImport(rows, { ...mapping, defaultType: 'host' }, AT);
    expect(read.observations[0]).toMatchObject({ type: 'host', identity: { serialNumber: 'SN-9', fqdn: 'srv-9.bank.local' }, attributes: { purchaseDate: '2024-03-01' }, tags: ['pci', 'prod'] });
    expect(readImport(rows, mapping, AT).rejected).toEqual([{ row: 1, reason: 'no type and no default type' }]);
    expect(attributeKey('  2nd line / cost centre ')).toBe('lineCostCentre');
    expect(attributeKey('###')).toBeNull();
    // An OpenMap export re-imports as it is: its headers are targets already.
    expect(suggestMapping(['type', 'name', 'identity.serialNumber', 'attribute.osName']).columns).toEqual({ type: 'type', name: 'name', 'identity.serialNumber': 'identity.serialNumber', 'attribute.osName': 'attribute.osName' });
  });
});
