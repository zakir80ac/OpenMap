// T-498 REQ-AI-002 — classification of unknown CIs from port-scan evidence:
// - every edge device the synthetic estate scans (its sysDescr, ports, OUI vendor and banner, as the port-scan
//   collector reports them) gets the right class, layer and type;
// - models the fingerprints were not written from are recognised by their product family and protocol;
// - a vendor or a port alone (a Cisco MAC, SNMP open) suggests nothing; the evidence explains every point.
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION } from '@openmap/constants';
import { classifyCi, type DeviceClass } from './classify.js';

function device(sysDescr: string | null, ports: number[], vendor: string | null, banner: string | null = null) {
  return { name: 'device', attributes: { sysDescr, openPorts: ports, vendorFromOui: vendor, httpBanner: banner } };
}

/** The synthetic estate's edge devices (tools/synth-estate catalog UNKNOWN_DEVICES), as the scan reports them. */
const ESTATE: Array<[DeviceClass, ReturnType<typeof device>]> = [
  ['printer', device('HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153,EEPROM V.45.12.NC,CIDATE 03/14/2023', [80, 443, 161, 515, 631, 9100], 'HP Inc.', 'HP Inc. embedded web server')],
  ['printer', device('Zebra ZT411 Printer, Link-OS 6.8.20Z', [80, 161, 9100], 'Zebra Technologies', 'Zebra Technologies embedded web server')],
  ['network_camera', device('AXIS P3245-LVE Network Camera 10.12.166', [80, 443, 554], 'Axis Communications', 'Axis Communications embedded web server')],
  ['network_camera', device('Hikvision DS-2CD2143G2-IU V5.7.3 build 220120', [80, 554, 8000], 'Hikvision', 'Hikvision embedded web server')],
  ['ups_management', device('APC Web/SNMP Management Card (MB:v4.1.0 PF:v7.1.2 PN:apc_hw05_aos_712.bin MN:AP9641 HR:5)', [80, 443, 161], 'Schneider Electric', 'Schneider Electric embedded web server')],
  ['access_control', device('HID VertX EVO V2000 Controller 3.7.1', [443, 4050], 'HID Global')],
  ['building_management', device('Honeywell WEBs-N4 4.13.2 (Niagara)', [80, 443, 1911, 4911], 'Honeywell', 'Honeywell embedded web server')],
  ['video_conference', device('Poly Studio X50 4.2.1-382015', [80, 443, 5060, 5061], 'Poly', 'Poly embedded web server')],
  ['ip_phone', device('Cisco IP Phone 8851, V03, sip88xx.14-2-1-0001-14', [80, 443, 5060], 'Cisco Systems', 'Cisco Systems embedded web server')],
  ['digital_signage', device('Samsung MagicINFO Player S7 QM55B T-KTM2ELAKUC-1120', [80, 7001], 'Samsung', 'Samsung embedded web server')],
  ['printer', device('Evolis Primacy 2 Printer', [80, 9100], 'Evolis', 'Evolis embedded web server')],
  ['cash_handling', device('Glory GFS-220 Network Module 2.3', [80, 5000], 'Glory', 'Glory embedded web server')],
  ['wireless_access_point', device('Aruba AP-535 ArubaOS 8.11.2', [22, 443, 4343], 'HPE Aruba')],
  ['iot_gateway', device('Raspberry Pi 4 Model B Rev 1.5 Linux 6.6.31+rpt-rpi-v8', [22, 1883], 'Raspberry Pi Foundation')],
];

/** Models no fingerprint was written from. */
const UNSEEN: Array<[DeviceClass, ReturnType<typeof device>]> = [
  ['printer', device('Canon iR-ADV C5535 printer', [80, 631, 9100], 'Canon')],
  ['network_camera', device('Dahua IPC-HDW2431T-AS-S2', [80, 554], 'Dahua')],
  ['ip_phone', device('Yealink SIP-T54W 96.86.0.70 VoIP', [80, 5060], 'Yealink')],
  ['digital_signage', device('BrightSign XT1144 8.5.47', [80], 'BrightSign')],
  ['ups_management', device('Eaton 9PX UPS Network-M2 card', [80, 161], 'Eaton')],
  ['wireless_access_point', device('UniFi U6-Pro 6.6.55', [22, 443], 'Ubiquiti')],
  ['building_management', device('Johnson Controls Metasys NAE55', [80, 47808], 'Johnson Controls')],
];

describe('classifying unknown CIs', () => {
  it.each(ESTATE)('recognises the estate scan of a %s', (expected, input) => {
    const c = classifyCi(input);
    expect(c?.deviceClass).toBe(expected);
    expect(c?.confidence).toBeGreaterThanOrEqual(CLASSIFICATION.minConfidence);
  });

  it.each(UNSEEN)('recognises an unseen %s by its family and protocol', (expected, input) => {
    expect(classifyCi(input)?.deviceClass).toBe(expected);
  });

  it('suggests the layer and the CMDB type where one exists, with the evidence behind the score', () => {
    const ups = classifyCi(ESTATE[4]![1]);
    expect(ups).toMatchObject({ layer: 'dc', type: 'ups' });
    const ap = classifyCi(ESTATE[12]![1]);
    expect(ap).toMatchObject({ layer: 'network_security', type: 'network_device' });
    const camera = classifyCi(ESTATE[2]![1]);
    expect(camera).toMatchObject({ layer: 'dc', type: null, title: 'AXIS P3245-LVE Network Camera 10.12.166' });
    expect(camera?.evidence.map((e) => e.signal)).toEqual(['sysDescr', 'banner', 'vendor', 'ports']);
    expect(camera?.confidence).toBeCloseTo(camera?.evidence.reduce((n, e) => n + e.weight, 0) ?? 0, 2);
    expect(camera?.description).toContain('ports: 554');
  });

  it('suggests nothing on a vendor or a port alone, or without evidence', () => {
    expect(classifyCi(device(null, [161], 'Cisco Systems'))).toBeNull();
    expect(classifyCi(device('Linux build-01 5.15.0-91-generic x86_64', [22], null))).toBeNull();
    expect(classifyCi({ name: 'x', attributes: {} })).toBeNull();
  });
});
