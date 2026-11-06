// T-208 REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — catalogue rows from endoflife.date's published shape (dates or booleans),
// support states, and the release an OS, network OS or hypervisor runs from what each collector reports.
import { describe, expect, it } from 'vitest';
import { daysToEndOfSupport, fromEndOfLifeDate, lifecycleState, osRelease, platformRelease, versionParts } from './lifecycle.js';

const now = new Date('2026-11-07T00:00:00.000Z');

describe('lifecycle catalogue', () => {
  it('reads release rows with dates or booleans', () => {
    const e = fromEndOfLifeDate('ubuntu', 'os', 'Ubuntu', { cycle: '22.04', codename: 'Jammy', lts: true, releaseDate: '2022-04-21', support: '2027-06-01', eol: '2027-06-01', extendedSupport: '2032-04-09', latest: '22.04.5' });
    expect(e).toMatchObject({ source: 'endoflife.date', product: 'ubuntu', cycle: '22.04', label: 'Ubuntu 22.04', endOfSupport: '2027-06-01', extendedSupportEnd: '2032-04-09', lts: true, supportEnded: false });
    const ended = fromEndOfLifeDate('centos', 'os', 'CentOS', { cycle: 7, eol: true, support: false });
    expect(ended).toMatchObject({ cycle: '7', endOfSupport: null, supportEnd: null, supportEnded: true });
    expect(fromEndOfLifeDate('windows-server', 'os', 'Windows Server', { cycle: '2012-r2', releaseLabel: 'Windows Server 2012 R2', eol: '2023-10-10' })?.label).toBe('Windows Server 2012 R2');
    expect(fromEndOfLifeDate('x', 'os', 'X', { eol: '2020-01-01' })).toBeNull();
  });

  it('classifies support', () => {
    expect(lifecycleState(null, now, 180)).toBe('unknown');
    expect(lifecycleState({ endOfSupport: null, supportEnded: false }, now, 180)).toBe('unknown');
    expect(lifecycleState({ endOfSupport: null, supportEnded: true }, now, 180)).toBe('ended');
    expect(lifecycleState({ endOfSupport: '2026-11-01', supportEnded: false }, now, 180)).toBe('ended');
    expect(lifecycleState({ endOfSupport: '2027-03-01', supportEnded: false }, now, 180)).toBe('ending');
    expect(lifecycleState({ endOfSupport: '2030-01-01', supportEnded: false }, now, 180)).toBe('supported');
    expect(daysToEndOfSupport({ endOfSupport: '2026-11-17' }, now)).toBe(10);
  });

  it('maps operating systems to releases', () => {
    expect(versionParts('24.04.1 LTS', 2)).toBe('24.04');
    expect(versionParts('9', 2)).toBeNull();
    expect(osRelease({ id: 'ubuntu', versionId: '22.04' })).toEqual({ product: 'ubuntu', cycle: '22.04' });
    expect(osRelease({ id: 'rhel', versionId: '9.4' })).toEqual({ product: 'rhel', cycle: '9' });
    expect(osRelease({ name: 'Red Hat Enterprise Linux', version: '9.4' })).toEqual({ product: 'rhel', cycle: '9' });
    expect(osRelease({ id: 'debian', versionId: '12' })).toEqual({ product: 'debian', cycle: '12' });
    expect(osRelease({ id: 'sles', versionId: '15.5' })).toEqual({ product: 'sles', cycle: '15.5' });
    expect(osRelease({ id: 'amzn', versionId: '2023' })).toEqual({ product: 'amazon-linux', cycle: '2023' });
    expect(osRelease({ caption: 'Microsoft Windows Server 2022 Standard', version: '10.0.20348' })).toEqual({ product: 'windows-server', cycle: '2022' });
    expect(osRelease({ caption: 'Microsoft Windows Server 2012 R2 Datacenter' })).toEqual({ product: 'windows-server', cycle: '2012-r2' });
    expect(osRelease({ name: 'Windows Server', version: '2019' })).toEqual({ product: 'windows-server', cycle: '2019' });
    expect(osRelease({ name: 'VMware ESXi', version: '8.0.3' })).toEqual({ product: 'esxi', cycle: '8.0' });
    expect(osRelease({ name: 'Nutanix AHV', version: '10.0' })).toBeNull();
    expect(osRelease({ id: 'ubuntu' })).toBeNull();
  });

  it('maps network operating systems and hypervisors to releases', () => {
    expect(platformRelease('network_device', { osName: 'IOS-XE', osVersion: '17.12.4' })).toEqual({ product: 'cisco-ios-xe', cycle: '17.12' });
    expect(platformRelease('network_device', { osName: 'PAN-OS', osVersion: '11.1.4-h7' })).toEqual({ product: 'panos', cycle: '11.1' });
    expect(platformRelease('load_balancer', { osName: 'TMOS', osVersion: '17.1.1' })).toEqual({ product: 'big-ip', cycle: '17.1' });
    expect(platformRelease('network_device', { osName: 'NX-OS', osVersion: '10.3(4a)' })).toBeNull();
    expect(platformRelease('hypervisor', { product: 'VMware vSphere 8.0 U3', version: '8.0.3' })).toEqual({ product: 'esxi', cycle: '8.0' });
    expect(platformRelease('hypervisor', { product: 'Nutanix AOS 6.10', version: '10.0' })).toEqual({ product: 'nutanix-aos', cycle: '6.10' });
    expect(platformRelease('hypervisor', { product: 'Microsoft Hyper-V 2022', version: '2022' })).toEqual({ product: 'windows-server', cycle: '2022' });
    expect(platformRelease('host', { product: 'x' })).toBeNull();
  });
});
