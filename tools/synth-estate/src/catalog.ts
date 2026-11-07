// REQ-QA-001 — reference catalogue the generators draw from: vendors, models, operating systems,
// software versions, application archetypes and business service names. Values are realistic
// product names so reconciliation, licence and vulnerability logic see production-shaped data.

export const DOMAIN = 'bank.local';
export const ORGANIZATION_NAME = 'Horizon Bank';
export const INDUSTRY = 'Banking';
export const TIME_ZONE = 'Asia/Riyadh';
export const COUNTRY = 'SA';
export const CURRENCY = 'SAR';
export const REGULATORY_SCOPE = ['SAMA CSF', 'NCA ECC', 'PCI DSS 4.0', 'SWIFT CSP'] as const;

export const BUSINESS_UNITS = ['Retail Banking', 'Corporate Banking', 'Treasury and Markets', 'Group Technology'] as const;

export interface SiteDef {
  code: string;
  name: string;
  kind: 'datacenter' | 'colocation' | 'office' | 'branch' | 'cloud_region';
  tier: number | null;
  city: string;
  countryCode: string;
  address: string;
  lat: number;
  lon: number;
  cloud: { provider: 'azure' | 'aws'; region: string } | null;
  /** Share of hosts placed here (data centres and the HQ server room only). */
  hostShare: number;
  /** Second-octet base of this site's 10.x.0.0/12 supernet. */
  octetBase: number;
  nodeIds: string[];
  building: string;
}

export const SITES: readonly SiteDef[] = [
  { code: 'RYD', name: 'Riyadh Primary Data Centre', kind: 'datacenter', tier: 3, city: 'Riyadh', countryCode: COUNTRY, address: 'King Abdullah Financial District, Riyadh', lat: 24.7676, lon: 46.6397, cloud: null, hostShare: 0.5, octetBase: 0, nodeIds: ['dn-ryd-01', 'dn-ryd-02'], building: 'DC1' },
  { code: 'JED', name: 'Jeddah Disaster Recovery Data Centre', kind: 'datacenter', tier: 3, city: 'Jeddah', countryCode: COUNTRY, address: 'Al Rawdah District, Jeddah', lat: 21.5433, lon: 39.1728, cloud: null, hostShare: 0.3, octetBase: 16, nodeIds: ['dn-jed-01'], building: 'DC2' },
  { code: 'DMM-COLO', name: 'Dammam Colocation Hall', kind: 'colocation', tier: 3, city: 'Dammam', countryCode: COUNTRY, address: 'Second Industrial City, Dammam', lat: 26.3927, lon: 49.9777, cloud: null, hostShare: 0.12, octetBase: 32, nodeIds: ['dn-dmm-01'], building: 'Hall 3' },
  { code: 'HQ', name: 'Head Office Tower', kind: 'office', tier: null, city: 'Riyadh', countryCode: COUNTRY, address: 'Olaya Street, Riyadh', lat: 24.6911, lon: 46.6855, cloud: null, hostShare: 0.08, octetBase: 48, nodeIds: ['dn-hq-01'], building: 'Tower A' },
  { code: 'BRANCH', name: 'Branch Network', kind: 'branch', tier: null, city: 'Riyadh', countryCode: COUNTRY, address: 'Nationwide branch bundle', lat: 24.7136, lon: 46.6753, cloud: null, hostShare: 0, octetBase: 64, nodeIds: ['dn-branch-01'], building: 'Branch' },
  { code: 'AZ-UAEN', name: 'Azure UAE North', kind: 'cloud_region', tier: null, city: 'Dubai', countryCode: 'AE', address: 'Microsoft Azure uaenorth', lat: 25.2048, lon: 55.2708, cloud: { provider: 'azure', region: 'uaenorth' }, hostShare: 0, octetBase: 128, nodeIds: ['dn-az-uaen-01'], building: 'Region' },
  { code: 'AWS-MES1', name: 'AWS Middle East (Bahrain)', kind: 'cloud_region', tier: null, city: 'Manama', countryCode: 'BH', address: 'Amazon Web Services me-south-1', lat: 26.2235, lon: 50.5876, cloud: { provider: 'aws', region: 'me-south-1' }, hostShare: 0, octetBase: 144, nodeIds: ['dn-aws-mes1-01'], building: 'Region' },
];

/** Offsets added to a site's octetBase for each address pool (each pool is a /16 inside the site /12). */
export const POOL = { mgmt: 0, oob: 1, servers: 2, vms: 4, storage: 8, k8s: 9, dmz: 10, links: 15 } as const;

export const VRF = { default: 'default', mgmt: 'MGMT', oob: 'OOB', prod: 'PROD', dmz: 'DMZ', storage: 'STORAGE' } as const;

export const VLAN_ID = { mgmt: 100, oob: 110, prodBase: 200, vmBase: 600, vmotion: 900, storage: 910, dmz: 950 } as const;

export interface VendorDef {
  name: string;
  oui: readonly [number, number, number];
  supportLevel: 'next_business_day' | 'four_hour' | 'mission_critical' | 'basic';
}

export const VENDORS: readonly VendorDef[] = [
  { name: 'Dell Technologies', oui: [0xf4, 0x02, 0x70], supportLevel: 'four_hour' },
  { name: 'Hewlett Packard Enterprise', oui: [0x94, 0x40, 0xc9], supportLevel: 'four_hour' },
  { name: 'Lenovo', oui: [0x7c, 0xd3, 0x0a], supportLevel: 'next_business_day' },
  { name: 'Cisco Systems', oui: [0x00, 0x1b, 0x54], supportLevel: 'mission_critical' },
  { name: 'Arista Networks', oui: [0x28, 0x99, 0x3a], supportLevel: 'four_hour' },
  { name: 'Juniper Networks', oui: [0x4c, 0x96, 0x14], supportLevel: 'four_hour' },
  { name: 'Palo Alto Networks', oui: [0x00, 0x1b, 0x17], supportLevel: 'mission_critical' },
  { name: 'Fortinet', oui: [0x00, 0x09, 0x0f], supportLevel: 'four_hour' },
  { name: 'F5', oui: [0x00, 0x01, 0xd7], supportLevel: 'four_hour' },
  { name: 'Broadcom VMware', oui: [0x00, 0x50, 0x56], supportLevel: 'mission_critical' },
  { name: 'Microsoft', oui: [0x00, 0x15, 0x5d], supportLevel: 'four_hour' },
  { name: 'Red Hat', oui: [0x52, 0x54, 0x00], supportLevel: 'basic' },
  { name: 'Canonical', oui: [0x52, 0x54, 0x00], supportLevel: 'basic' },
  { name: 'Oracle', oui: [0x00, 0x10, 0xe0], supportLevel: 'mission_critical' },
  { name: 'NetApp', oui: [0x00, 0xa0, 0x98], supportLevel: 'four_hour' },
  { name: 'Pure Storage', oui: [0x24, 0xa9, 0x37], supportLevel: 'four_hour' },
  { name: 'Brocade', oui: [0x00, 0x05, 0x1e], supportLevel: 'four_hour' },
  { name: 'Nutanix', oui: [0x50, 0x6b, 0x8d], supportLevel: 'four_hour' },
  { name: 'Schneider Electric', oui: [0x00, 0xc0, 0xb7], supportLevel: 'next_business_day' },
  { name: 'Vertiv', oui: [0x00, 0x0e, 0xb6], supportLevel: 'next_business_day' },
];

export interface HostModelDef {
  manufacturer: string;
  model: string;
  heightU: 1 | 2;
  cpuSockets: number;
  coresPerSocket: number;
  memoryGb: number;
  bmcProduct: string;
  bmcFirmware: string;
  serialPrefix: string;
  partNumber: string;
}

export const HOST_MODELS: readonly HostModelDef[] = [
  { manufacturer: 'Dell Technologies', model: 'PowerEdge R650', heightU: 1, cpuSockets: 2, coresPerSocket: 32, memoryGb: 512, bmcProduct: 'iDRAC9', bmcFirmware: '7.10.70', serialPrefix: 'D', partNumber: '0R650' },
  { manufacturer: 'Dell Technologies', model: 'PowerEdge R750', heightU: 2, cpuSockets: 2, coresPerSocket: 32, memoryGb: 1024, bmcProduct: 'iDRAC9', bmcFirmware: '7.10.70', serialPrefix: 'D', partNumber: '0R750' },
  { manufacturer: 'Dell Technologies', model: 'PowerEdge R760', heightU: 2, cpuSockets: 2, coresPerSocket: 48, memoryGb: 1536, bmcProduct: 'iDRAC9', bmcFirmware: '7.10.70', serialPrefix: 'D', partNumber: '0R760' },
  { manufacturer: 'Hewlett Packard Enterprise', model: 'ProLiant DL360 Gen11', heightU: 1, cpuSockets: 2, coresPerSocket: 32, memoryGb: 512, bmcProduct: 'iLO 6', bmcFirmware: '1.62', serialPrefix: 'CZ', partNumber: 'P52563-B21' },
  { manufacturer: 'Hewlett Packard Enterprise', model: 'ProLiant DL380 Gen11', heightU: 2, cpuSockets: 2, coresPerSocket: 40, memoryGb: 1024, bmcProduct: 'iLO 6', bmcFirmware: '1.62', serialPrefix: 'CZ', partNumber: 'P52560-B21' },
  { manufacturer: 'Hewlett Packard Enterprise', model: 'ProLiant DL380 Gen10 Plus', heightU: 2, cpuSockets: 2, coresPerSocket: 28, memoryGb: 768, bmcProduct: 'iLO 5', bmcFirmware: '3.06', serialPrefix: 'CZ', partNumber: 'P05172-B21' },
  { manufacturer: 'Lenovo', model: 'ThinkSystem SR630 V3', heightU: 1, cpuSockets: 2, coresPerSocket: 32, memoryGb: 512, bmcProduct: 'XClarity Controller 2', bmcFirmware: '4.30', serialPrefix: 'J', partNumber: '7D73CTO1WW' },
  { manufacturer: 'Lenovo', model: 'ThinkSystem SR650 V3', heightU: 2, cpuSockets: 2, coresPerSocket: 40, memoryGb: 1024, bmcProduct: 'XClarity Controller 2', bmcFirmware: '4.30', serialPrefix: 'J', partNumber: '7D76CTO1WW' },
];

export interface OsDef {
  family: 'linux' | 'windows' | 'esxi' | 'ahv';
  name: string;
  version: string;
  kernel: string;
  collector: 'ssh_agentless' | 'wmi';
}

export const OS_UBUNTU: OsDef = { family: 'linux', name: 'Ubuntu', version: '24.04', kernel: '6.8.0-45-generic', collector: 'ssh_agentless' };
export const OS_RHEL: OsDef = { family: 'linux', name: 'Red Hat Enterprise Linux', version: '9.4', kernel: '5.14.0-427.37.1.el9_4', collector: 'ssh_agentless' };
export const OS_WINDOWS: OsDef = { family: 'windows', name: 'Windows Server', version: '2022', kernel: '10.0.20348', collector: 'wmi' };
export const OS_ESXI: OsDef = { family: 'esxi', name: 'VMware ESXi', version: '8.0.3', kernel: '8.0.3-24022510', collector: 'ssh_agentless' };
export const OS_AHV: OsDef = { family: 'ahv', name: 'Nutanix AHV', version: '10.0', kernel: '5.10.194-1.nutanix', collector: 'ssh_agentless' };

export const BARE_METAL_OS: readonly OsDef[] = [OS_UBUNTU, OS_RHEL, OS_WINDOWS];
export const BARE_METAL_OS_WEIGHTS: readonly number[] = [35, 35, 30];

export type HypervisorPlatform = 'vmware' | 'hyperv' | 'nutanix_ahv' | 'kvm_libvirt';
export const HYPERVISOR_PLATFORMS: readonly HypervisorPlatform[] = ['vmware', 'hyperv', 'nutanix_ahv', 'kvm_libvirt'];
export const HYPERVISOR_PLATFORM_WEIGHTS: readonly number[] = [60, 15, 15, 10];
export const HYPERVISOR_OS: Record<HypervisorPlatform, OsDef> = { vmware: OS_ESXI, hyperv: OS_WINDOWS, nutanix_ahv: OS_AHV, kvm_libvirt: OS_RHEL };
export const HYPERVISOR_PREFIX: Record<HypervisorPlatform, string> = { vmware: 'esx', hyperv: 'hv', nutanix_ahv: 'ahv', kvm_libvirt: 'kvm' };
export const HYPERVISOR_PRODUCT: Record<HypervisorPlatform, string> = { vmware: 'VMware vSphere 8.0 U3', hyperv: 'Microsoft Hyper-V 2022', nutanix_ahv: 'Nutanix AOS 6.10', kvm_libvirt: 'libvirt 10.0 / QEMU 8.2' };
export const HYPERVISOR_COLLECTOR: Record<HypervisorPlatform, string> = { vmware: 'vmware-vcenter', hyperv: 'hyperv-scvmm', nutanix_ahv: 'nutanix-prism', kvm_libvirt: 'kvm-libvirt' };

export const GUEST_OS: readonly OsDef[] = [OS_UBUNTU, OS_RHEL, OS_WINDOWS];
export const GUEST_OS_WEIGHTS: readonly number[] = [40, 35, 25];

export interface NetworkModelDef {
  role: 'core' | 'distribution' | 'access' | 'management' | 'firewall' | 'load_balancer' | 'wan_router' | 'branch_switch';
  manufacturer: string;
  model: string;
  osName: string;
  osVersion: string;
  /** SNMP sysObjectID arcs, joined with dots at run time. */
  sysObjectId: readonly number[];
  ports: number;
  speedMbps: number;
  heightU: number;
  ifPrefix: string;
  serialPrefix: string;
}

export const NETWORK_MODELS: readonly NetworkModelDef[] = [
  { role: 'core', manufacturer: 'Cisco Systems', model: 'Nexus 9364C-GX', osName: 'NX-OS', osVersion: '10.3(4a)', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 12, 3, 1, 3, 2494], ports: 64, speedMbps: 100_000, heightU: 2, ifPrefix: 'Ethernet1/', serialPrefix: 'FDO' },
  { role: 'core', manufacturer: 'Arista Networks', model: 'DCS-7280CR3-32P4', osName: 'EOS', osVersion: '4.32.2F', sysObjectId: [1, 3, 6, 1, 4, 1, 30065, 1, 3011, 7280, 3735, 3, 4, 1], ports: 36, speedMbps: 100_000, heightU: 1, ifPrefix: 'Ethernet', serialPrefix: 'JPE' },
  { role: 'distribution', manufacturer: 'Cisco Systems', model: 'Nexus 93180YC-FX3', osName: 'NX-OS', osVersion: '10.3(4a)', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 12, 3, 1, 3, 2305], ports: 54, speedMbps: 25_000, heightU: 1, ifPrefix: 'Ethernet1/', serialPrefix: 'FDO' },
  { role: 'distribution', manufacturer: 'Arista Networks', model: 'DCS-7050SX3-48YC8', osName: 'EOS', osVersion: '4.32.2F', sysObjectId: [1, 3, 6, 1, 4, 1, 30065, 1, 3011, 7050, 3735, 48, 2905, 8], ports: 56, speedMbps: 25_000, heightU: 1, ifPrefix: 'Ethernet', serialPrefix: 'JPE' },
  { role: 'access', manufacturer: 'Cisco Systems', model: 'Nexus 93108TC-FX3P', osName: 'NX-OS', osVersion: '10.3(4a)', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 12, 3, 1, 3, 2306], ports: 54, speedMbps: 10_000, heightU: 1, ifPrefix: 'Ethernet1/', serialPrefix: 'FDO' },
  { role: 'access', manufacturer: 'Arista Networks', model: 'DCS-7050TX3-48C8', osName: 'EOS', osVersion: '4.32.2F', sysObjectId: [1, 3, 6, 1, 4, 1, 30065, 1, 3011, 7050, 3735, 48, 2878, 8], ports: 56, speedMbps: 10_000, heightU: 1, ifPrefix: 'Ethernet', serialPrefix: 'JPE' },
  { role: 'management', manufacturer: 'Cisco Systems', model: 'Catalyst 9300-48T', osName: 'IOS-XE', osVersion: '17.12.4', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 1, 2494], ports: 52, speedMbps: 1_000, heightU: 1, ifPrefix: 'GigabitEthernet1/0/', serialPrefix: 'FJC' },
  { role: 'firewall', manufacturer: 'Palo Alto Networks', model: 'PA-5440', osName: 'PAN-OS', osVersion: '11.1.4-h7', sysObjectId: [1, 3, 6, 1, 4, 1, 25461, 2, 3, 56], ports: 24, speedMbps: 100_000, heightU: 3, ifPrefix: 'ethernet1/', serialPrefix: '0139' },
  { role: 'firewall', manufacturer: 'Fortinet', model: 'FortiGate 4201F', osName: 'FortiOS', osVersion: '7.4.5', sysObjectId: [1, 3, 6, 1, 4, 1, 12356, 101, 1, 42001], ports: 24, speedMbps: 100_000, heightU: 3, ifPrefix: 'port', serialPrefix: 'FG42' },
  { role: 'load_balancer', manufacturer: 'F5', model: 'BIG-IP i7800', osName: 'TMOS', osVersion: '17.1.1', sysObjectId: [1, 3, 6, 1, 4, 1, 3375, 2, 1, 3, 4, 113], ports: 12, speedMbps: 40_000, heightU: 2, ifPrefix: '1.', serialPrefix: 'f5-' },
  { role: 'wan_router', manufacturer: 'Cisco Systems', model: 'Catalyst 8300-1N1S-4T2X', osName: 'IOS-XE', osVersion: '17.12.4', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 1, 2902], ports: 6, speedMbps: 10_000, heightU: 1, ifPrefix: 'GigabitEthernet0/0/', serialPrefix: 'FLM' },
  { role: 'branch_switch', manufacturer: 'Cisco Systems', model: 'Catalyst 9200L-24P-4G', osName: 'IOS-XE', osVersion: '17.12.4', sysObjectId: [1, 3, 6, 1, 4, 1, 9, 1, 2652], ports: 28, speedMbps: 1_000, heightU: 1, ifPrefix: 'GigabitEthernet1/0/', serialPrefix: 'JAE' },
];

/** Interfaces materialised per device role when no cabling drives the count (uplinks, trunks, HA links). */
export const INTERFACES_EMITTED: Record<NetworkModelDef['role'], number> = { core: 24, distribution: 48, access: 4, management: 4, firewall: 8, load_balancer: 6, wan_router: 4, branch_switch: 8 };
export const UPLINKS_PER_ACCESS = 2;

export interface StorageModelDef {
  manufacturer: string;
  model: string;
  rawTb: number;
  protocol: 'fc' | 'iscsi' | 'nvme-fc';
  serialPrefix: string;
  heightU: number;
  /**
   * NAA-6 prefix of the array's LUN WWNs: "6" and the vendor's IEEE OUI, as the array reports them (Pure 24a937,
   * NetApp 00a098, Dell 8ccf09). The volume serial follows.
   */
  naaPrefix: string;
  /** NetApp encodes its 12-character LUN serial as hex after the prefix; the others use a 24-hex volume serial. */
  lunSerial: 'ascii' | 'hex';
}

export const STORAGE_MODELS: readonly StorageModelDef[] = [
  { manufacturer: 'Pure Storage', model: 'FlashArray//X90 R4', rawTb: 1500, protocol: 'nvme-fc', serialPrefix: 'PCTFL', heightU: 3, naaPrefix: 'naa.624a9370', lunSerial: 'hex' },
  { manufacturer: 'NetApp', model: 'AFF A900', rawTb: 2200, protocol: 'fc', serialPrefix: '7212', heightU: 8, naaPrefix: 'naa.600a0980', lunSerial: 'ascii' },
  { manufacturer: 'Dell Technologies', model: 'PowerStore 5200T', rawTb: 1100, protocol: 'fc', serialPrefix: 'PS', heightU: 2, naaPrefix: 'naa.68ccf098', lunSerial: 'hex' },
];

export const FC_SWITCH_MODELS = [
  { manufacturer: 'Brocade', model: 'G720', ports: 64, fos: 'FOS 9.2.1a', serialPrefix: 'BRC' },
  { manufacturer: 'Cisco Systems', model: 'MDS 9148T', ports: 48, fos: 'NX-OS 9.4(2)', serialPrefix: 'JPG' },
] as const;

export const PDU_MODELS = [
  { manufacturer: 'Schneider Electric', model: 'APC AP8953', outlets: 24, ratedAmps: 32, serialPrefix: 'ZA' },
  { manufacturer: 'Vertiv', model: 'Geist rPDU GU2', outlets: 36, ratedAmps: 32, serialPrefix: 'GZ' },
] as const;

export const UPS_MODELS = [
  { manufacturer: 'Schneider Electric', model: 'Galaxy VL 500 kW', ratedKw: 500, serialPrefix: 'GVL' },
  { manufacturer: 'Vertiv', model: 'Liebert EXL S1 800 kVA', ratedKw: 720, serialPrefix: 'LEX' },
] as const;

export const COOLING_MODELS = [
  { manufacturer: 'Vertiv', model: 'Liebert PDX 120', coolingKw: 120, serialPrefix: 'LPX' },
  { manufacturer: 'Schneider Electric', model: 'Uniflair LE HDCV', coolingKw: 150, serialPrefix: 'UFL' },
] as const;

export interface SoftwareDef {
  vendor: string;
  name: string;
  version: string;
  /** Operating system families this package appears on. */
  on: readonly OsDef['family'][];
  /** Install path segments; joined at run time with the platform separator. */
  path: readonly string[];
  licensed: boolean;
  category: 'agent' | 'runtime' | 'database' | 'web' | 'middleware' | 'os' | 'security';
}

export const SOFTWARE: readonly SoftwareDef[] = [
  { vendor: 'CrowdStrike', name: 'Falcon Sensor', version: '7.18.17405', on: ['linux', 'windows'], path: ['opt', 'CrowdStrike'], licensed: true, category: 'agent' },
  { vendor: 'Zabbix', name: 'Zabbix Agent 2', version: '7.0.4', on: ['linux', 'windows'], path: ['usr', 'sbin', 'zabbix_agent2'], licensed: false, category: 'agent' },
  { vendor: 'Splunk', name: 'Universal Forwarder', version: '9.3.1', on: ['linux', 'windows'], path: ['opt', 'splunkforwarder'], licensed: true, category: 'agent' },
  { vendor: 'Qualys', name: 'Cloud Agent', version: '6.3.1', on: ['linux', 'windows'], path: ['usr', 'local', 'qualys', 'cloud-agent'], licensed: true, category: 'security' },
  { vendor: 'OpenBSD', name: 'OpenSSH', version: '9.8p1', on: ['linux', 'esxi', 'ahv'], path: ['usr', 'sbin', 'sshd'], licensed: false, category: 'os' },
  { vendor: 'OpenSSL Project', name: 'OpenSSL', version: '3.0.14', on: ['linux'], path: ['usr', 'lib64'], licensed: false, category: 'os' },
  { vendor: 'F5', name: 'NGINX', version: '1.26.2', on: ['linux'], path: ['usr', 'sbin', 'nginx'], licensed: false, category: 'web' },
  { vendor: 'Apache Software Foundation', name: 'HTTP Server', version: '2.4.62', on: ['linux'], path: ['usr', 'sbin', 'httpd'], licensed: false, category: 'web' },
  { vendor: 'Microsoft', name: 'Internet Information Services', version: '10.0.20348', on: ['windows'], path: ['C:', 'Windows', 'System32', 'inetsrv'], licensed: false, category: 'web' },
  { vendor: 'Eclipse Adoptium', name: 'Temurin JDK', version: '21.0.4+7', on: ['linux', 'windows'], path: ['usr', 'lib', 'jvm', 'temurin-21'], licensed: false, category: 'runtime' },
  { vendor: 'Eclipse Adoptium', name: 'Temurin JDK', version: '17.0.12+7', on: ['linux', 'windows'], path: ['usr', 'lib', 'jvm', 'temurin-17'], licensed: false, category: 'runtime' },
  { vendor: 'Microsoft', name: '.NET Runtime', version: '8.0.8', on: ['windows', 'linux'], path: ['usr', 'share', 'dotnet'], licensed: false, category: 'runtime' },
  { vendor: 'OpenJS Foundation', name: 'Node.js', version: '22.9.0', on: ['linux'], path: ['usr', 'local', 'bin', 'node'], licensed: false, category: 'runtime' },
  { vendor: 'Apache Software Foundation', name: 'Tomcat', version: '10.1.28', on: ['linux', 'windows'], path: ['opt', 'tomcat'], licensed: false, category: 'middleware' },
  { vendor: 'Apache Software Foundation', name: 'Log4j Core', version: '2.17.2', on: ['linux', 'windows'], path: ['opt', 'tomcat', 'lib'], licensed: false, category: 'middleware' },
  { vendor: 'Red Hat', name: 'JBoss EAP', version: '8.0.3', on: ['linux'], path: ['opt', 'jboss-eap'], licensed: true, category: 'middleware' },
  { vendor: 'Apache Software Foundation', name: 'Kafka', version: '3.8.0', on: ['linux'], path: ['opt', 'kafka'], licensed: false, category: 'middleware' },
  { vendor: 'Redis Ltd', name: 'Redis', version: '7.4.0', on: ['linux'], path: ['usr', 'bin', 'redis-server'], licensed: false, category: 'middleware' },
  { vendor: 'PostgreSQL Global Development Group', name: 'PostgreSQL', version: '16.4', on: ['linux'], path: ['usr', 'pgsql-16'], licensed: false, category: 'database' },
  { vendor: 'Oracle', name: 'Database Enterprise Edition', version: '19.24.0', on: ['linux'], path: ['u01', 'app', 'oracle', 'product', '19c'], licensed: true, category: 'database' },
  { vendor: 'Microsoft', name: 'SQL Server', version: '2022 CU14', on: ['windows'], path: ['C:', 'Program Files', 'Microsoft SQL Server', 'MSSQL16.MSSQLSERVER'], licensed: true, category: 'database' },
  { vendor: 'MongoDB', name: 'MongoDB Server', version: '7.0.14', on: ['linux'], path: ['usr', 'bin', 'mongod'], licensed: true, category: 'database' },
  { vendor: 'Elastic', name: 'Elasticsearch', version: '8.15.2', on: ['linux'], path: ['usr', 'share', 'elasticsearch'], licensed: true, category: 'database' },
  { vendor: 'Veeam', name: 'Backup and Replication', version: '12.2.0.334', on: ['windows'], path: ['C:', 'Program Files', 'Veeam', 'Backup and Replication'], licensed: true, category: 'agent' },
  { vendor: 'Broadcom VMware', name: 'vCenter Server', version: '8.0.3.00200', on: ['linux'], path: ['usr', 'lib', 'vmware-vpx'], licensed: true, category: 'middleware' },
  { vendor: 'Broadcom VMware', name: 'VMware Tools', version: '12.4.5', on: ['linux', 'windows'], path: ['usr', 'bin', 'vmware-toolbox-cmd'], licensed: false, category: 'agent' },
  { vendor: 'Microsoft', name: 'Windows Server Datacenter', version: '2022 21H2', on: ['windows'], path: ['C:', 'Windows'], licensed: true, category: 'os' },
  { vendor: 'Red Hat', name: 'Enterprise Linux Server Subscription', version: '9', on: ['linux'], path: ['etc', 'redhat-release'], licensed: true, category: 'os' },
  { vendor: 'Canonical', name: 'Ubuntu Pro', version: '24.04', on: ['linux'], path: ['etc', 'os-release'], licensed: true, category: 'os' },
  { vendor: 'Broadcom VMware', name: 'vSphere Enterprise Plus', version: '8.0', on: ['esxi'], path: ['bootbank'], licensed: true, category: 'os' },
  { vendor: 'Nutanix', name: 'AOS Ultimate', version: '6.10', on: ['ahv'], path: ['home', 'nutanix'], licensed: true, category: 'os' },
  { vendor: 'HashiCorp', name: 'Vault', version: '1.17.6', on: ['linux'], path: ['usr', 'bin', 'vault'], licensed: false, category: 'security' },
  { vendor: 'Keycloak', name: 'Keycloak', version: '25.0.6', on: ['linux'], path: ['opt', 'keycloak'], licensed: false, category: 'middleware' },
  { vendor: 'Internet Systems Consortium', name: 'BIND', version: '9.18.28', on: ['linux'], path: ['usr', 'sbin', 'named'], licensed: false, category: 'middleware' },
  { vendor: 'Internet Systems Consortium', name: 'Kea DHCP', version: '2.6.1', on: ['linux'], path: ['usr', 'sbin', 'kea-dhcp4'], licensed: false, category: 'middleware' },
  { vendor: 'Zabbix', name: 'Zabbix Server', version: '7.0.4', on: ['linux'], path: ['usr', 'sbin', 'zabbix_server'], licensed: false, category: 'agent' },
  { vendor: 'curl Project', name: 'curl', version: '8.9.1', on: ['linux'], path: ['usr', 'bin', 'curl'], licensed: false, category: 'os' },
  { vendor: 'GNU Project', name: 'glibc', version: '2.39', on: ['linux'], path: ['usr', 'lib64'], licensed: false, category: 'os' },
  { vendor: 'Linux Kernel Organization', name: 'Linux Kernel', version: '6.8.0-45', on: ['linux'], path: ['boot'], licensed: false, category: 'os' },
  { vendor: 'Samba Team', name: 'Samba', version: '4.20.4', on: ['linux'], path: ['usr', 'sbin', 'smbd'], licensed: false, category: 'middleware' },
];

export type DbEngine = 'postgresql' | 'oracle' | 'sqlserver';
export const DB_ENGINE_PORT: Record<DbEngine, number> = { postgresql: 5432, oracle: 1521, sqlserver: 1433 };
export const DB_ENGINE_SHORT: Record<DbEngine, string> = { postgresql: 'pg', oracle: 'ora', sqlserver: 'mssql' };
export const DB_ENGINE_SOFTWARE: Record<DbEngine, string> = { postgresql: 'PostgreSQL', oracle: 'Database Enterprise Edition', sqlserver: 'SQL Server' };
export const DB_ENGINE_PRODUCT: Record<DbEngine, string> = { postgresql: 'PostgreSQL 16.4 (Patroni)', oracle: 'Oracle Database 19c RAC', sqlserver: 'SQL Server 2022 Always On' };
export const DB_ENGINE_PROCESS: Record<DbEngine, string> = { postgresql: 'postgres', oracle: 'tnslsnr', sqlserver: 'sqlservr' };

export type Runtime = 'java' | 'dotnet' | 'node';
export interface AppArchetypeDef {
  slug: string;
  title: string;
  engine: DbEngine;
  runtime: Runtime;
  /** True when web and api tiers run as Kubernetes workloads instead of VMs. */
  containerised: boolean;
  dbNames: readonly string[];
}

export const APP_ARCHETYPES: readonly AppArchetypeDef[] = [
  { slug: 'cbs', title: 'Core Banking', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['core', 'gl', 'audit'] },
  { slug: 'ib', title: 'Internet Banking', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['ib', 'sessions'] },
  { slug: 'mb', title: 'Mobile Banking', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['mb', 'push'] },
  { slug: 'cards', title: 'Card Management', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['cards', 'auth'] },
  { slug: 'atm', title: 'ATM Switch', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['switch', 'journal'] },
  { slug: 'pos', title: 'POS Acquiring', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['acq', 'settle'] },
  { slug: 'swift', title: 'SWIFT Gateway', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['swift'] },
  { slug: 'sarie', title: 'SARIE Instant Payments', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['ips', 'ledger'] },
  { slug: 'cash', title: 'Corporate Cash Management', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['cash'] },
  { slug: 'trade', title: 'Trade Finance', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['trade', 'docs'] },
  { slug: 'treasury', title: 'Treasury and FX', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['tms', 'rates'] },
  { slug: 'lo', title: 'Loan Origination', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['lo', 'scoring'] },
  { slug: 'mortgage', title: 'Mortgage Servicing', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['mtg'] },
  { slug: 'kyc', title: 'KYC Onboarding', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['kyc', 'documents'] },
  { slug: 'aml', title: 'AML Monitoring', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['aml', 'cases'] },
  { slug: 'fraud', title: 'Fraud Detection', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['fraud', 'features'] },
  { slug: 'ccc', title: 'Contact Centre', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['ccc', 'ivr'] },
  { slug: 'crm', title: 'CRM', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['crm'] },
  { slug: 'hr', title: 'HR and Payroll', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['hr', 'payroll'] },
  { slug: 'gl', title: 'General Ledger', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['gl'] },
  { slug: 'regrep', title: 'Regulatory Reporting', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['regrep', 'sama'] },
  { slug: 'dwh', title: 'Data Warehouse', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['edw', 'staging', 'marts'] },
  { slug: 'bi', title: 'Business Intelligence', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['bi'] },
  { slug: 'openapi', title: 'Open Banking APIs', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['consent', 'tpp'] },
  { slug: 'wealth', title: 'Wealth Management', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['wealth'] },
  { slug: 'teller', title: 'Branch Teller', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['teller'] },
  { slug: 'notif', title: 'Notifications', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['notif'] },
  { slug: 'dms', title: 'Document Management', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['dms'] },
  { slug: 'bpm', title: 'Process Automation', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['bpm'] },
  { slug: 'esb', title: 'Enterprise Service Bus', engine: 'postgresql', runtime: 'java', containerised: false, dbNames: ['esb'] },
  { slug: 'apigw', title: 'API Gateway', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['gw'] },
  { slug: 'procure', title: 'Procurement', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['proc'] },
  { slug: 'collections', title: 'Collections', engine: 'sqlserver', runtime: 'dotnet', containerised: false, dbNames: ['coll'] },
  { slug: 'limits', title: 'Limits and Collateral', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['limits'] },
  { slug: 'fx', title: 'FX Dealing', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['fx'] },
  { slug: 'securities', title: 'Securities Custody', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['custody'] },
  { slug: 'islamic', title: 'Islamic Finance Products', engine: 'oracle', runtime: 'java', containerised: false, dbNames: ['islamic'] },
  { slug: 'statements', title: 'Statement Generation', engine: 'postgresql', runtime: 'java', containerised: true, dbNames: ['stmt'] },
  { slug: 'chatbot', title: 'Virtual Assistant', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['bot'] },
  { slug: 'ekyc', title: 'Digital Identity', engine: 'postgresql', runtime: 'node', containerised: true, dbNames: ['ekyc'] },
];

export const APP_VARIANTS = ['', 'retail', 'corp', 'sme', 'priv', 'intl', 'v2', 'dr', 'uat', 'pilot'] as const;

export const SHARED_AUTH_APP: AppArchetypeDef = { slug: 'iam-sso', title: 'Identity and Access (SSO)', engine: 'postgresql', runtime: 'java', containerised: false, dbNames: ['keycloak'] };

export interface InfraAppDef {
  slug: string;
  title: string;
  listenPort: number;
  protocol: 'tcp' | 'udp';
  process: string;
  os: OsDef;
}
export const INFRA_APPS: readonly InfraAppDef[] = [
  { slug: 'infra-dns', title: 'Internal DNS', listenPort: 53, protocol: 'udp', process: 'named', os: OS_RHEL },
  { slug: 'infra-monitoring', title: 'Monitoring (Zabbix)', listenPort: 10051, protocol: 'tcp', process: 'zabbix_server', os: OS_UBUNTU },
  { slug: 'infra-backup', title: 'Backup (Veeam)', listenPort: 9392, protocol: 'tcp', process: 'Veeam.Backup.Service', os: OS_WINDOWS },
];

export const TIER_PORT = { web: 443, api: 8443 } as const;
export const RUNTIME_PROCESS: Record<Runtime, string> = { java: 'java', dotnet: 'dotnet', node: 'node' };
export const SSH_PORT = 22;
export const RDP_PORT = 3389;
export const WINRM_PORT = 5985;
export const SNMP_PORT = 161;
export const HTTPS_PORT = 443;
export const DNS_PORT = 53;
export const ZABBIX_AGENT_PORT = 10050;

export const BUSINESS_SERVICE_BASES = [
  'Retail Internet Banking', 'Mobile Banking', 'Card Issuing', 'Card Acquiring', 'ATM Network', 'POS Network', 'SWIFT Payments', 'SARIE Instant Payments',
  'Corporate Cash Management', 'Trade Finance', 'Treasury FX', 'Money Markets', 'Loan Origination', 'Mortgage Servicing', 'Auto Finance', 'Personal Finance',
  'KYC Onboarding', 'AML Monitoring', 'Fraud Detection', 'Sanctions Screening', 'Customer Contact Centre', 'CRM and Campaigns', 'HR and Payroll',
  'General Ledger', 'Regulatory Reporting', 'Data Warehouse and BI', 'Identity and Access', 'Open Banking APIs', 'Wealth Management', 'Branch Teller',
  'Customer Notifications', 'Document Management', 'Process Automation', 'Integration Services', 'API Gateway', 'Procurement', 'Collections and Recovery',
  'Limits and Collateral', 'Securities Custody', 'Islamic Finance', 'Statements', 'Virtual Assistant', 'Digital Identity', 'Merchant Portal', 'Payroll Cards',
  'Remittances', 'Cheque Clearing', 'Standing Orders', 'Bill Payments (SADAD)', 'Government Payments',
] as const;
export const BUSINESS_SERVICE_SEGMENTS = ['', 'Retail', 'Corporate', 'SME', 'Private', 'Islamic', 'Digital', 'International', 'Branch', 'Agency'] as const;

export interface UnknownDeviceDef {
  kind: string;
  sysDescr: string;
  ports: readonly number[];
  oui: readonly [number, number, number];
  vendor: string;
}
export const UNKNOWN_DEVICES: readonly UnknownDeviceDef[] = [
  { kind: 'printer', sysDescr: 'HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153,EEPROM V.45.12.NC,CIDATE 03/14/2023', ports: [80, 443, 161, 515, 631, 9100], oui: [0x3c, 0xd9, 0x2b], vendor: 'HP Inc.' },
  { kind: 'printer', sysDescr: 'Zebra ZT411 Printer, Link-OS 6.8.20Z', ports: [80, 161, 9100], oui: [0x00, 0x07, 0x4d], vendor: 'Zebra Technologies' },
  { kind: 'camera', sysDescr: 'AXIS P3245-LVE Network Camera 10.12.166', ports: [80, 443, 554], oui: [0xac, 0xcc, 0x8e], vendor: 'Axis Communications' },
  { kind: 'camera', sysDescr: 'Hikvision DS-2CD2143G2-IU V5.7.3 build 220120', ports: [80, 554, 8000], oui: [0x44, 0x47, 0xcc], vendor: 'Hikvision' },
  { kind: 'ups_card', sysDescr: 'APC Web/SNMP Management Card (MB:v4.1.0 PF:v7.1.2 PN:apc_hw05_aos_712.bin AF1:v7.1.2 AN1:apc_hw05_sumx_712.bin MN:AP9641 HR:5)', ports: [80, 443, 161], oui: [0x00, 0xc0, 0xb7], vendor: 'Schneider Electric' },
  { kind: 'access_control', sysDescr: 'HID VertX EVO V2000 Controller 3.7.1', ports: [443, 4050], oui: [0x00, 0x06, 0x8e], vendor: 'HID Global' },
  { kind: 'bms', sysDescr: 'Honeywell WEBs-N4 4.13.2 (Niagara)', ports: [80, 443, 1911, 4911], oui: [0x00, 0x40, 0x84], vendor: 'Honeywell' },
  { kind: 'video_conference', sysDescr: 'Poly Studio X50 4.2.1-382015', ports: [80, 443, 5060, 5061], oui: [0x64, 0x16, 0x7f], vendor: 'Poly' },
  { kind: 'ip_phone', sysDescr: 'Cisco IP Phone 8851, V03, sip88xx.14-2-1-0001-14', ports: [80, 443, 5060], oui: [0x00, 0x1b, 0x54], vendor: 'Cisco Systems' },
  { kind: 'signage', sysDescr: 'Samsung MagicINFO Player S7 QM55B T-KTM2ELAKUC-1120', ports: [80, 7001], oui: [0x8c, 0xc8, 0xcd], vendor: 'Samsung' },
  { kind: 'badge_printer', sysDescr: 'Evolis Primacy 2 Printer', ports: [80, 9100], oui: [0x00, 0x1e, 0xc0], vendor: 'Evolis' },
  { kind: 'cash_counter', sysDescr: 'Glory GFS-220 Network Module 2.3', ports: [80, 5000], oui: [0x00, 0x0a, 0x51], vendor: 'Glory' },
  { kind: 'wifi_ap', sysDescr: 'Aruba AP-535 ArubaOS 8.11.2', ports: [22, 443, 4343], oui: [0x20, 0x4c, 0x03], vendor: 'HPE Aruba' },
  { kind: 'iot_sensor', sysDescr: 'Raspberry Pi 4 Model B Rev 1.5 Linux 6.6.31+rpt-rpi-v8', ports: [22, 1883], oui: [0xd8, 0x3a, 0xdd], vendor: 'Raspberry Pi Foundation' },
];

export const K8S_VERSION = 'v1.30.5';
export const K8S_RUNTIME = 'containerd://1.7.22';
export const K8S_SYSTEM_NAMESPACES = ['kube-system', 'ingress-nginx', 'monitoring', 'cert-manager'] as const;

export const CVE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const CVE_SEVERITY_WEIGHTS: readonly number[] = [10, 35, 40, 15];

export const COST_CENTRES = [
  { code: 'CC-1000', name: 'Retail Banking Technology' },
  { code: 'CC-2000', name: 'Corporate Banking Technology' },
  { code: 'CC-3000', name: 'Treasury Technology' },
  { code: 'CC-4000', name: 'Group Technology Infrastructure' },
  { code: 'CC-4100', name: 'Information Security' },
  { code: 'CC-4200', name: 'Data and Analytics' },
] as const;

export const CLOUD_RESOURCE_TYPES: Record<'azure' | 'aws', readonly string[]> = {
  azure: ['Microsoft.Network/virtualNetworks', 'Microsoft.Compute/virtualMachines', 'Microsoft.Storage/storageAccounts', 'Microsoft.KeyVault/vaults', 'Microsoft.Sql/servers/databases', 'Microsoft.Network/applicationGateways', 'Microsoft.Network/networkSecurityGroups', 'Microsoft.Web/sites', 'Microsoft.Network/privateEndpoints', 'Microsoft.Compute/disks'],
  aws: ['AWS::EC2::VPC', 'AWS::EC2::Instance', 'AWS::RDS::DBInstance', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::EC2::SecurityGroup', 'AWS::Lambda::Function', 'AWS::KMS::Key', 'AWS::EC2::Volume', 'AWS::DynamoDB::Table', 'AWS::SQS::Queue'],
};
