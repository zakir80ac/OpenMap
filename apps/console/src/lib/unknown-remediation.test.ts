// T-128 REQ-CMDB-040 — the diagnosis of an unknown device from what the scanners recorded: power gear answering SNMP
// goes to the DCIM collector, an unmetered PDU with nothing listening is manual entry, an odd port is an unknown
// application, a device not seen for a month is stale, and the evidence lists the facts behind each verdict.
import { ASSETS, TIME } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { diagnoseUnknown } from './unknown-remediation';

const now = new Date('2026-11-05T12:00:00.000Z');
const recent = new Date(now.getTime() - TIME.msPerDay).toISOString();

describe('unknown device remediation', () => {
  it('sends an SNMP-reachable UPS card to the DCIM collector', () => {
    const r = diagnoseUnknown({ deviceKind: 'ups_card', snmpReachable: true, openPorts: [80, 443, 161], sysDescr: 'APC Web/SNMP Management Card', vendorFromOui: 'Schneider Electric', lastSeen: recent }, now);
    expect(r.kind).toBe('snmp_power');
    expect(r.suggestedLayer).toBe('dc');
    expect(r.suggestedType).toBe('ups');
    expect(r.manageable).toBe(true);
    expect(r.evidence.map((e) => e.key)).toEqual(['deviceKind', 'sysDescr', 'vendor', 'openPorts', 'snmp', 'lastSeen']);
    expect(r.stale).toBe(false);
  });

  it('marks a device with no SNMP, no web interface and no open port as manual entry only', () => {
    const r = diagnoseUnknown({ deviceKind: 'pdu', snmpReachable: false, openPorts: [], lastSeen: recent }, now);
    expect(r.kind).toBe('no_management');
    expect(r.manageable).toBe(false);
    expect(r.suggestedType).toBe('pdu');
  });

  it('flags an unknown application on a non-standard port', () => {
    const r = diagnoseUnknown({ deviceKind: 'signage', snmpReachable: false, openPorts: [80, 7001], httpBanner: 'Samsung embedded web server', lastSeen: recent }, now);
    expect(r.kind).toBe('unknown_service');
    expect(r.nonStandardPorts).toEqual([7001]);
    expect(r.suggestedLayer).toBe('hardware');
  });

  it('treats a web-only endpoint as labelable with manual cover', () => {
    const r = diagnoseUnknown({ deviceKind: 'camera', snmpReachable: false, openPorts: [80, 443, 554], httpBanner: 'Axis embedded web server', lastSeen: recent }, now);
    expect(r.kind).toBe('endpoint');
    expect(r.manageable).toBe(true);
  });

  it('flags a device not seen for longer than the stale window as stale and still diagnoses it', () => {
    const old = new Date(now.getTime() - (ASSETS.unknownStaleDays + 1) * TIME.msPerDay).toISOString();
    const r = diagnoseUnknown({ deviceKind: 'ups_card', snmpReachable: true, openPorts: [161], lastSeen: old }, now);
    expect(r.stale).toBe(true);
    expect(r.kind).toBe('snmp_power');
    expect(diagnoseUnknown({ deviceKind: 'ups_card', snmpReachable: true, openPorts: [161], lastSeen: recent }, now).stale).toBe(false);
  });

  it('places a kind it does not know in hardware as a host and copes with missing attributes', () => {
    const r = diagnoseUnknown({}, now);
    expect(r.kind).toBe('no_management');
    expect(r.suggestedType).toBe('host');
    expect(r.evidence).toEqual([{ key: 'snmp', value: 'no' }]);
  });
});
