// REQ-CMDB-040 — what to do about a device discovery found but could not classify (ADR-023). Pure rules over the
// attributes the port scanner and SNMP probe recorded (deviceKind, sysDescr, openPorts, snmpReachable, httpBanner,
// vendorFromOui, lastSeen): each unknown CI gets a diagnosis, the layer and type it most likely belongs to, the
// evidence behind that, and whether the device can be managed at all or must be recorded by hand.
import { ASSETS, TIME } from '@openmap/constants';
import type { CiLayer, CiType } from '@openmap/contracts';
import type { JsonValue } from '@/lib/queries';

export type RemediationKind =
  /** SNMP answers and the device is power equipment: add it to the DCIM collector's scope. */
  | 'snmp_power'
  /** SNMP answers: add a credential for the right collector and it classifies itself. */
  | 'snmp_device'
  /** Something listens on a port no well-known service uses: an unknown application needs a credential or a label. */
  | 'unknown_service'
  /** No SNMP, no web interface, no open port: no out-of-band management; record it by hand. */
  | 'no_management'
  /** Only a web interface: an endpoint without a management protocol; label it and record its cover by hand. */
  | 'endpoint';

export interface Remediation {
  kind: RemediationKind;
  /** Not seen for ASSETS.unknownStaleDays: probably gone; confirm it is still installed before anything else. */
  stale: boolean;
  suggestedLayer: CiLayer;
  suggestedType: CiType;
  /** Attribute facts the diagnosis rests on, in display order: [label key, value]. */
  evidence: Array<{ key: EvidenceKey; value: string }>;
  /** Ports outside the well-known set, when the kind is unknown_service. */
  nonStandardPorts: number[];
  /** Whether the device can be managed remotely at all; false means manual entry is the only way to keep it current. */
  manageable: boolean;
}

export type EvidenceKey = 'deviceKind' | 'sysDescr' | 'vendor' | 'openPorts' | 'snmp' | 'httpBanner' | 'lastSeen' | 'osGuess';

/** Where a device kind the scanner recognises belongs once labelled. */
const KIND_PLACEMENT: Readonly<Record<string, { layer: CiLayer; type: CiType }>> = {
  ups_card: { layer: 'dc', type: 'ups' },
  ups: { layer: 'dc', type: 'ups' },
  pdu: { layer: 'dc', type: 'pdu' },
  cooling: { layer: 'dc', type: 'cooling_unit' },
  wifi_ap: { layer: 'network_security', type: 'network_device' },
  switch: { layer: 'network_security', type: 'network_device' },
  router: { layer: 'network_security', type: 'network_device' },
  firewall: { layer: 'network_security', type: 'network_device' },
  load_balancer: { layer: 'network_security', type: 'load_balancer' },
  storage: { layer: 'storage', type: 'storage_array' },
  hypervisor: { layer: 'virtualization', type: 'hypervisor' },
  server: { layer: 'hardware', type: 'host' },
  printer: { layer: 'hardware', type: 'host' },
  camera: { layer: 'hardware', type: 'host' },
  ip_phone: { layer: 'hardware', type: 'host' },
  signage: { layer: 'hardware', type: 'host' },
  iot_sensor: { layer: 'hardware', type: 'host' },
  video_conference: { layer: 'hardware', type: 'host' },
  access_control: { layer: 'hardware', type: 'host' },
  workstation: { layer: 'hardware', type: 'host' },
};
const DEFAULT_PLACEMENT = { layer: 'hardware', type: 'host' } as const;
const POWER_KINDS: ReadonlySet<string> = new Set(['ups_card', 'ups', 'pdu', 'cooling']);
const WELL_KNOWN: ReadonlySet<number> = new Set(ASSETS.wellKnownPorts);

function str(attributes: Record<string, JsonValue>, key: string): string | null {
  const v = attributes[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function ports(attributes: Record<string, JsonValue>): number[] {
  const v = attributes['openPorts'];
  return Array.isArray(v) ? v.filter((p): p is number => typeof p === 'number') : [];
}

export function diagnoseUnknown(attributes: Record<string, JsonValue>, now: Date): Remediation {
  const deviceKind = str(attributes, 'deviceKind');
  const placement = (deviceKind !== null ? KIND_PLACEMENT[deviceKind] : undefined) ?? DEFAULT_PLACEMENT;
  const snmp = attributes['snmpReachable'] === true;
  const banner = str(attributes, 'httpBanner');
  const open = ports(attributes);
  const nonStandard = open.filter((p) => !WELL_KNOWN.has(p));
  const lastSeen = str(attributes, 'lastSeen');
  const evidence: Remediation['evidence'] = [];
  if (deviceKind !== null) evidence.push({ key: 'deviceKind', value: deviceKind });
  const sysDescr = str(attributes, 'sysDescr');
  if (sysDescr !== null) evidence.push({ key: 'sysDescr', value: sysDescr });
  const vendor = str(attributes, 'vendorFromOui');
  if (vendor !== null) evidence.push({ key: 'vendor', value: vendor });
  if (open.length > 0) evidence.push({ key: 'openPorts', value: open.join(', ') });
  evidence.push({ key: 'snmp', value: snmp ? 'yes' : 'no' });
  if (banner !== null) evidence.push({ key: 'httpBanner', value: banner });
  const osGuess = str(attributes, 'osGuess');
  if (osGuess !== null) evidence.push({ key: 'osGuess', value: osGuess });
  if (lastSeen !== null) evidence.push({ key: 'lastSeen', value: lastSeen });

  const seenAt = lastSeen === null ? Number.NaN : new Date(lastSeen).getTime();
  const stale = !Number.isNaN(seenAt) && now.getTime() - seenAt > ASSETS.unknownStaleDays * TIME.msPerDay;
  const base = { suggestedLayer: placement.layer, suggestedType: placement.type, evidence, nonStandardPorts: nonStandard, stale };
  if (snmp && deviceKind !== null && POWER_KINDS.has(deviceKind)) return { ...base, kind: 'snmp_power', manageable: true };
  if (snmp) return { ...base, kind: 'snmp_device', manageable: true };
  if (nonStandard.length > 0) return { ...base, kind: 'unknown_service', manageable: true };
  if (banner === null && open.length === 0) return { ...base, kind: 'no_management', manageable: false };
  return { ...base, kind: 'endpoint', manageable: banner !== null };
}
