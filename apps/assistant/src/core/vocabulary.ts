// REQ-AI-007 (ADR-028) — the bilingual vocabulary the intent classifier reads questions with: CI types, attribute
// families, measurements, aggregates, grouping words, intent markers and periods, in English and Arabic. It is a
// catalogue, not a model: a term either occurs in the normalised question or it does not, and every match is kept
// on the classification so the evidence shows why a question was read the way it was. Arabic is matched after
// normalisation (diacritics, alef forms, taa marbuta, Arabic-Indic digits) with the common clitic prefixes allowed.
import { ASSISTANT, TIME } from '@openmap/constants';
import type { AssistantAggregate, AssistantIntent, CiType } from '@openmap/contracts';

export interface Terms {
  en: readonly string[];
  ar: readonly string[];
}

/** CI types the assistant names in questions; every other type is reached through the graph skill. */
export const TYPE_TERMS: Partial<Record<CiType, Terms>> = {
  host: {
    en: ['host', 'hosts', 'server', 'servers', 'physical server', 'physical servers', 'bare metal'],
    ar: ['مضيف', 'مضيفين', 'المضيفين', 'خادم', 'خوادم', 'الخوادم', 'سيرفر', 'سيرفرات'],
  },
  vm: {
    en: ['vm', 'vms', 'virtual machine', 'virtual machines', 'guest', 'guests'],
    ar: [
      'جهاز افتراضي',
      'أجهزة افتراضية',
      'الأجهزة الافتراضية',
      'آلة افتراضية',
      'آلات افتراضية',
      'الآلات الافتراضية',
    ],
  },
  hypervisor: {
    en: ['hypervisor', 'hypervisors', 'esxi host', 'esxi hosts', 'esx host', 'esx hosts', 'hyper-v host'],
    ar: ['هايبرفايزر', 'مشرف افتراضي', 'المشرفين الافتراضيين', 'مضيف esxi'],
  },
  vm_cluster: {
    en: ['vm cluster', 'vm clusters', 'vsphere cluster', 'vsphere clusters', 'compute cluster'],
    ar: ['عنقود افتراضي', 'عناقيد افتراضية'],
  },
  operating_system: {
    en: ['operating system', 'operating systems'],
    ar: ['نظام تشغيل', 'أنظمة تشغيل', 'أنظمة التشغيل'],
  },
  network_device: {
    en: [
      'network device',
      'network devices',
      'switch',
      'switches',
      'router',
      'routers',
      'firewall',
      'firewalls',
    ],
    ar: [
      'جهاز شبكة',
      'أجهزة شبكة',
      'أجهزة الشبكة',
      'سويتش',
      'سويتشات',
      'محول',
      'محولات',
      'راوتر',
      'موجه',
      'موجهات',
      'جدار ناري',
      'جدران نارية',
    ],
  },
  interface: { en: ['interface', 'interfaces', 'port', 'ports'], ar: ['واجهة', 'واجهات', 'منفذ', 'منافذ'] },
  vlan: { en: ['vlan', 'vlans'], ar: ['vlan', 'شبكة محلية افتراضية'] },
  subnet: {
    en: ['subnet', 'subnets', 'network range', 'prefix', 'prefixes'],
    ar: ['شبكة فرعية', 'شبكات فرعية', 'الشبكات الفرعية'],
  },
  ip_address: { en: ['ip address', 'ip addresses', 'ips'], ar: ['عنوان ip', 'عناوين ip'] },
  rack: { en: ['rack', 'racks', 'cabinet', 'cabinets'], ar: ['رف', 'رفوف', 'الرفوف', 'خزانة', 'خزائن'] },
  site: {
    en: [
      'site',
      'sites',
      'data center',
      'data centers',
      'datacenter',
      'datacenters',
      'data centre',
      'data centres',
      'location',
      'locations',
      'branch',
      'branches',
    ],
    ar: ['موقع', 'مواقع', 'المواقع', 'مركز بيانات', 'مراكز بيانات', 'مراكز البيانات', 'فرع', 'فروع'],
  },
  pdu: {
    en: ['pdu', 'pdus', 'power distribution unit', 'power distribution units'],
    ar: ['وحدة توزيع طاقة', 'وحدات توزيع الطاقة', 'وحدات توزيع طاقة'],
  },
  storage_array: {
    en: ['storage array', 'storage arrays', 'san', 'storage system', 'storage systems'],
    ar: ['مصفوفة تخزين', 'مصفوفات تخزين', 'مصفوفات التخزين', 'نظام تخزين', 'أنظمة التخزين'],
  },
  database: {
    en: ['database', 'databases', 'db', 'dbs'],
    ar: ['قاعدة بيانات', 'قواعد بيانات', 'قواعد البيانات'],
  },
  application: { en: ['application', 'applications', 'app', 'apps'], ar: ['تطبيق', 'تطبيقات', 'التطبيقات'] },
  business_service: {
    en: ['business service', 'business services', 'service', 'services'],
    ar: ['خدمة أعمال', 'خدمات أعمال', 'خدمات الأعمال', 'خدمة', 'خدمات', 'الخدمات'],
  },
  software: {
    en: ['software', 'software product', 'software products', 'product', 'products'],
    ar: ['برمجية', 'برمجيات', 'البرمجيات', 'برنامج', 'برامج'],
  },
  software_instance: {
    en: ['installation', 'installations', 'installed software', 'software instance', 'software instances'],
    ar: ['تثبيت', 'تثبيتات', 'نسخة برمجية', 'نسخ برمجية'],
  },
  licence: {
    en: ['licence', 'licences', 'license', 'licenses'],
    ar: ['رخصة', 'رخص', 'الرخص', 'ترخيص', 'تراخيص'],
  },
  vulnerability: {
    en: ['vulnerability', 'vulnerabilities', 'cve', 'cves'],
    ar: ['ثغرة', 'ثغرات', 'الثغرات'],
  },
  k8s_cluster: {
    en: ['kubernetes cluster', 'kubernetes clusters', 'k8s cluster', 'k8s clusters'],
    ar: ['عنقود kubernetes', 'عناقيد kubernetes'],
  },
  k8s_workload: {
    en: ['workload', 'workloads', 'deployment', 'deployments', 'pod', 'pods'],
    ar: ['حمولة', 'حمولات', 'أحمال'],
  },
  container: { en: ['container', 'containers'], ar: ['حاوية', 'حاويات', 'الحاويات'] },
  cloud_account: {
    en: [
      'cloud account',
      'cloud accounts',
      'subscription',
      'subscriptions',
      'aws account',
      'azure subscription',
    ],
    ar: ['حساب سحابي', 'حسابات سحابية', 'الحسابات السحابية', 'اشتراك سحابي'],
  },
  cloud_resource: {
    en: ['cloud resource', 'cloud resources', 'cloud instance', 'cloud instances'],
    ar: ['مورد سحابي', 'موارد سحابية', 'الموارد السحابية'],
  },
  saas_application: {
    en: ['saas application', 'saas applications', 'saas app', 'saas apps', 'saas'],
    ar: ['تطبيق saas', 'تطبيقات saas'],
  },
  certificate: { en: ['certificate', 'certificates', 'cert', 'certs'], ar: ['شهادة', 'شهادات', 'الشهادات'] },
  contract: {
    en: ['contract', 'contracts', 'support contract', 'support contracts'],
    ar: ['عقد', 'عقود', 'العقود'],
  },
  vendor: { en: ['vendor', 'vendors', 'supplier', 'suppliers'], ar: ['مورد', 'موردين', 'الموردين', 'بائع'] },
  ups: { en: ['ups', 'upses'], ar: ['ups', 'مزود طاقة احتياطي'] },
  cooling_unit: {
    en: ['cooling unit', 'cooling units', 'crac', 'cracs'],
    ar: ['وحدة تبريد', 'وحدات تبريد', 'وحدات التبريد'],
  },
  user_account: {
    en: ['user account', 'user accounts', 'user', 'users'],
    ar: ['حساب مستخدم', 'حسابات مستخدمين', 'مستخدم', 'مستخدمين', 'المستخدمين'],
  },
};

/** An attribute family: the words people use, the attribute keys collectors write, the unit and whether it is numeric. */
export interface AttributeFamily {
  terms: Terms;
  /** Candidate keys in precedence order; the first one present on the tenant's CIs of the type is used. */
  keys: readonly string[];
  unit: string;
  numeric: boolean;
}

export const ATTRIBUTE_FAMILIES = {
  memory: {
    terms: { en: ['memory', 'ram', 'memory gb', 'memory size'], ar: ['ذاكرة', 'الذاكرة', 'رام'] },
    keys: ['memoryGb'],
    unit: 'GB',
    numeric: true,
  },
  cpu: {
    terms: {
      en: ['cpu cores', 'cores', 'cpus', 'vcpus', 'vcpu', 'processors', 'cpu count'],
      ar: ['أنوية', 'الأنوية', 'نوى', 'معالجات', 'المعالجات'],
    },
    keys: ['cpuCores', 'vcpus'],
    unit: '',
    numeric: true,
  },
  disk: {
    terms: {
      en: ['disk', 'disk size', 'storage size', 'disk gb'],
      ar: ['قرص', 'القرص', 'مساحة القرص', 'التخزين'],
    },
    keys: ['diskGb'],
    unit: 'GB',
    numeric: true,
  },
  os: {
    terms: {
      en: ['os', 'operating system', 'operating systems', 'guest os'],
      ar: ['نظام التشغيل', 'نظام تشغيل', 'أنظمة التشغيل', 'أنظمة تشغيل'],
    },
    keys: ['osName', 'guestOs', 'family'],
    unit: '',
    numeric: false,
  },
  osVersion: {
    terms: { en: ['os version', 'version'], ar: ['إصدار', 'الإصدار', 'نسخة النظام'] },
    keys: ['osVersion', 'version'],
    unit: '',
    numeric: false,
  },
  manufacturer: {
    terms: {
      en: ['manufacturer', 'manufacturers', 'make', 'brand', 'brands'],
      ar: ['مصنع', 'المصنع', 'الشركة المصنعة', 'ماركة'],
    },
    keys: ['manufacturer', 'vendor'],
    unit: '',
    numeric: false,
  },
  model: {
    terms: { en: ['model', 'models', 'hardware model'], ar: ['طراز', 'الطراز', 'موديل', 'الموديل'] },
    keys: ['model', 'product'],
    unit: '',
    numeric: false,
  },
  platform: {
    terms: {
      en: ['platform', 'platforms', 'virtualisation platform', 'virtualization platform'],
      ar: ['منصة', 'المنصة', 'منصات'],
    },
    keys: ['platform'],
    unit: '',
    numeric: false,
  },
  site: {
    terms: {
      en: ['site', 'sites', 'location', 'locations', 'data center', 'data centre'],
      ar: ['موقع', 'المواقع', 'مواقع', 'مركز بيانات', 'مراكز البيانات'],
    },
    keys: ['site'],
    unit: '',
    numeric: false,
  },
  rack: {
    terms: { en: ['rack', 'racks'], ar: ['رف', 'الرف', 'رفوف', 'الرفوف'] },
    keys: ['rack'],
    unit: '',
    numeric: false,
  },
  cluster: {
    terms: { en: ['cluster', 'clusters'], ar: ['عنقود', 'العنقود', 'عناقيد', 'كلستر'] },
    keys: ['cluster'],
    unit: '',
    numeric: false,
  },
  role: {
    terms: { en: ['role', 'roles', 'purpose'], ar: ['دور', 'الدور', 'أدوار', 'الغرض'] },
    keys: ['role', 'applicationRole', 'purpose'],
    unit: '',
    numeric: false,
  },
  powerState: {
    terms: {
      en: ['power state', 'powered on', 'powered off', 'running or stopped'],
      ar: ['حالة الطاقة', 'مشغل', 'متوقف'],
    },
    keys: ['powerState'],
    unit: '',
    numeric: false,
  },
  family: {
    terms: { en: ['os family', 'family', 'families'], ar: ['عائلة', 'العائلة', 'عائلات'] },
    keys: ['family', 'guestOsFamily'],
    unit: '',
    numeric: false,
  },
  uptime: {
    terms: { en: ['uptime seconds', 'time since boot', 'booted'], ar: ['مدة التشغيل', 'منذ الإقلاع'] },
    keys: ['uptimeSeconds', 'sysUptimeSeconds'],
    unit: 's',
    numeric: true,
  },
  ports: {
    terms: { en: ['port count', 'number of ports'], ar: ['عدد المنافذ'] },
    keys: ['portCount'],
    unit: '',
    numeric: true,
  },
  tier: {
    terms: { en: ['tier', 'tiers'], ar: ['فئة', 'الفئة', 'مستوى', 'المستوى'] },
    keys: ['tier'],
    unit: '',
    numeric: true,
  },
  criticality: {
    terms: { en: ['criticality'], ar: ['حرجية', 'الحرجية', 'الأهمية'] },
    keys: ['criticality'],
    unit: '',
    numeric: false,
  },
  status: {
    terms: { en: ['status', 'state'], ar: ['حالة', 'الحالة'] },
    keys: ['status', 'connectionState', 'lifecycle'],
    unit: '',
    numeric: false,
  },
  vrf: { terms: { en: ['vrf', 'vrfs'], ar: ['vrf'] }, keys: ['vrf'], unit: '', numeric: false },
  prefixLength: {
    terms: { en: ['prefix length', 'mask', 'netmask'], ar: ['طول البادئة', 'القناع'] },
    keys: ['prefixLength'],
    unit: '',
    numeric: true,
  },
  warrantyEnd: {
    terms: { en: ['warranty', 'warranty end', 'warranty expiry'], ar: ['ضمان', 'الضمان', 'انتهاء الضمان'] },
    keys: ['warrantyEnd'],
    unit: '',
    numeric: false,
  },
  users: {
    terms: {
      en: ['users affected', 'user count', 'number of users'],
      ar: ['عدد المستخدمين', 'المستخدمين المتأثرين'],
    },
    keys: ['users', 'usersAffected'],
    unit: '',
    numeric: true,
  },
  revenue: {
    terms: { en: ['revenue', 'revenue per hour'], ar: ['إيراد', 'الإيراد', 'الإيرادات'] },
    keys: ['revenuePerHour'],
    unit: '',
    numeric: true,
  },
} as const satisfies Record<string, AttributeFamily>;
export type AttributeFamilyId = keyof typeof ATTRIBUTE_FAMILIES;
export const ATTRIBUTE_FAMILY_IDS = Object.keys(ATTRIBUTE_FAMILIES) as AttributeFamilyId[];

/** Measurements in ClickHouse: the metric name, the words, the unit and the CI types that carry it. */
export interface MeasurementSpec {
  terms: Terms;
  unit: string;
  subjects: readonly CiType[];
}

export const MEASUREMENTS = {
  'host.cpu.utilisation_percent': {
    terms: {
      en: ['cpu utilisation', 'cpu utilization', 'cpu usage', 'cpu load', 'processor usage', 'cpu'],
      ar: ['استخدام المعالج', 'استهلاك المعالج', 'حمل المعالج', 'المعالج'],
    },
    unit: '%',
    subjects: ['host'],
  },
  'host.memory.utilisation_percent': {
    terms: {
      en: ['memory utilisation', 'memory utilization', 'memory usage', 'ram usage', 'memory pressure'],
      ar: ['استخدام الذاكرة', 'استهلاك الذاكرة'],
    },
    unit: '%',
    subjects: ['host'],
  },
  'vm.cpu.utilisation_percent': {
    terms: {
      en: ['vm cpu', 'cpu utilisation', 'cpu utilization', 'cpu usage', 'cpu load', 'cpu'],
      ar: ['استخدام المعالج', 'استهلاك المعالج', 'المعالج'],
    },
    unit: '%',
    subjects: ['vm'],
  },
  'container.cpu.utilisation_percent': {
    terms: {
      en: ['container cpu', 'cpu utilisation', 'cpu usage', 'cpu'],
      ar: ['استخدام المعالج', 'المعالج'],
    },
    unit: '%',
    subjects: ['container', 'k8s_workload'],
  },
  'net.device.throughput_gbps': {
    terms: {
      en: ['throughput', 'traffic', 'bandwidth', 'gbps'],
      ar: ['معدل النقل', 'حركة البيانات', 'الترافيك', 'عرض النطاق'],
    },
    unit: 'Gbps',
    subjects: ['network_device'],
  },
  'dcim.power.watts': {
    terms: {
      en: ['power', 'power draw', 'watts', 'consumption', 'power consumption'],
      ar: ['طاقة', 'الطاقة', 'استهلاك الطاقة', 'واط'],
    },
    unit: 'W',
    subjects: ['pdu', 'rack'],
  },
  'dcim.site.pue': {
    terms: { en: ['pue', 'power usage effectiveness'], ar: ['pue', 'كفاءة استخدام الطاقة'] },
    unit: '',
    subjects: ['site'],
  },
  'ipam.subnet.utilisation_percent': {
    terms: {
      en: [
        'subnet utilisation',
        'subnet utilization',
        'ip utilisation',
        'ip usage',
        'address usage',
        'used addresses',
      ],
      ar: ['استخدام الشبكة الفرعية', 'استخدام العناوين'],
    },
    unit: '%',
    subjects: ['subnet'],
  },
  'os.patch.compliance_percent': {
    terms: {
      en: ['patch compliance', 'patched', 'patch level', 'patching'],
      ar: ['امتثال التحديثات', 'التحديثات', 'الترقيعات'],
    },
    unit: '%',
    subjects: ['operating_system'],
  },
  'storage.array.iops': {
    terms: { en: ['storage iops', 'array iops', 'iops'], ar: ['iops', 'عمليات التخزين'] },
    unit: 'IOPS',
    subjects: ['storage_array'],
  },
  'db.instance.iops': {
    terms: { en: ['database iops', 'db iops', 'iops'], ar: ['iops', 'عمليات قاعدة البيانات'] },
    unit: 'IOPS',
    subjects: ['database'],
  },
  'app.apdex.score': {
    terms: { en: ['apdex', 'application performance', 'response score'], ar: ['apdex', 'أداء التطبيق'] },
    unit: '',
    subjects: ['application', 'application_component'],
  },
  'cloud.resource.load_percent': {
    terms: { en: ['cloud load', 'instance load', 'load'], ar: ['حمل السحابة', 'الحمل'] },
    unit: '%',
    subjects: ['cloud_resource'],
  },
  'saas.seat.utilisation_percent': {
    terms: {
      en: ['seat utilisation', 'seat utilization', 'seats used', 'seat usage'],
      ar: ['استخدام المقاعد', 'المقاعد المستخدمة'],
    },
    unit: '%',
    subjects: ['saas_application'],
  },
} as const satisfies Record<string, MeasurementSpec>;
export type MeasurementName = keyof typeof MEASUREMENTS;
export const MEASUREMENT_NAMES = Object.keys(MEASUREMENTS) as MeasurementName[];

export const AGGREGATE_TERMS: Record<AssistantAggregate, Terms> = {
  count: {
    en: ['how many', 'count', 'number of', 'total number', 'how much'],
    ar: ['كم', 'عدد', 'ما عدد', 'كم عدد', 'إجمالي عدد'],
  },
  avg: {
    en: ['average', 'avg', 'mean', 'typical', 'on average'],
    ar: ['متوسط', 'المتوسط', 'معدل', 'المعدل', 'في المتوسط'],
  },
  sum: {
    en: ['total', 'sum', 'combined', 'altogether', 'overall'],
    ar: ['مجموع', 'المجموع', 'إجمالي', 'الإجمالي', 'الكلي'],
  },
  max: {
    en: ['maximum', 'max', 'highest', 'largest', 'biggest', 'most', 'top', 'busiest', 'hottest'],
    ar: ['أعلى', 'الأعلى', 'أكبر', 'الأكبر', 'الأكثر', 'أقصى', 'الأقصى'],
  },
  min: {
    en: ['minimum', 'min', 'lowest', 'smallest', 'least', 'fewest', 'idle'],
    ar: ['أقل', 'الأقل', 'أدنى', 'الأدنى', 'أصغر', 'الأصغر'],
  },
  distribution: {
    en: ['breakdown', 'distribution', 'split', 'share', 'which versions', 'what versions', 'list of'],
    ar: ['توزيع', 'التوزيع', 'تفصيل', 'تقسيم'],
  },
};

/** "per site", "by platform", "for each rack": the question wants one row per group. */
export const GROUP_TERMS: Terms = {
  en: ['per', 'by', 'each', 'for each', 'grouped by', 'broken down by', 'across'],
  ar: ['لكل', 'بكل', 'في كل', 'حسب', 'بحسب', 'وفق', 'موزعة', 'موزعين'],
};

/** Words that decide the intent before any type or attribute is considered. */
export const INTENT_TERMS: Record<
  Exclude<AssistantIntent, 'lookup' | 'count' | 'attribute_stats' | 'measurement' | 'unknown'>,
  Terms
> = {
  availability: {
    en: [
      'uptime',
      'availability',
      'available',
      'sla',
      'slas',
      'downtime',
      'error budget',
      'burn rate',
      'met its target',
      'nines',
    ],
    ar: [
      'التوافر',
      'توافر',
      'وقت التشغيل',
      'زمن التشغيل',
      'الجاهزية',
      'اتفاقية مستوى الخدمة',
      'مستوى الخدمة',
      'التعطل',
      'وقت التعطل',
      'ميزانية الخطأ',
    ],
  },
  incidents: {
    en: ['incident', 'incidents', 'outage', 'outages', 'open issues', 'tickets'],
    ar: ['حادث', 'حادثة', 'حوادث', 'الحوادث', 'انقطاع', 'انقطاعات', 'الانقطاعات', 'عطل', 'أعطال'],
  },
  impact: {
    en: [
      'impact',
      'impacted',
      'affected',
      'depend on',
      'depends on',
      'dependent on',
      'what breaks',
      'blast radius',
      'if it fails',
      'goes down',
      'root cause',
    ],
    ar: [
      'تأثير',
      'التأثير',
      'يتأثر',
      'تتأثر',
      'المتأثرة',
      'تعتمد على',
      'يعتمد على',
      'الاعتماد',
      'إذا تعطل',
      'إذا توقف',
      'السبب الجذري',
    ],
  },
  history: {
    en: [
      'history',
      'changed',
      'change history',
      'when did',
      'since last',
      'previous version',
      'what changed',
      'timeline',
      'as of',
    ],
    ar: [
      'تاريخ',
      'التاريخ',
      'تغير',
      'تغيّر',
      'التغييرات',
      'ما الذي تغير',
      'متى',
      'سجل',
      'السجل',
      'النسخة السابقة',
    ],
  },
  howto: {
    en: [
      'how do i',
      'how can i',
      'how to',
      'where do i',
      'where can i',
      'what is openmap',
      'what does openmap',
      'help me',
      'explain how',
    ],
    ar: ['كيف', 'كيفية', 'أين أجد', 'أين يمكنني', 'ما هو openmap', 'ساعدني', 'اشرح'],
  },
  report: {
    en: ['report', 'export', 'csv', 'spreadsheet', 'download'],
    ar: ['تقرير', 'التقرير', 'تصدير', 'csv', 'تحميل'],
  },
};

export interface PeriodSpec {
  granularity: 'month' | 'quarter' | 'year';
  /** 0 is the current period, 1 the previous one. */
  back: number;
  terms: Terms;
}

export const PERIODS: Record<
  'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'thisYear' | 'lastYear',
  PeriodSpec
> = {
  thisMonth: {
    granularity: 'month',
    back: 0,
    terms: {
      en: ['this month', 'current month', 'month to date'],
      ar: ['هذا الشهر', 'الشهر الحالي', 'الشهر الجاري'],
    },
  },
  lastMonth: {
    granularity: 'month',
    back: 1,
    terms: {
      en: ['last month', 'previous month', 'past month'],
      ar: ['الشهر الماضي', 'الشهر السابق', 'الشهر المنصرم'],
    },
  },
  thisQuarter: {
    granularity: 'quarter',
    back: 0,
    terms: {
      en: ['this quarter', 'current quarter', 'quarter to date'],
      ar: ['هذا الربع', 'الربع الحالي', 'الربع الجاري'],
    },
  },
  lastQuarter: {
    granularity: 'quarter',
    back: 1,
    terms: { en: ['last quarter', 'previous quarter'], ar: ['الربع الماضي', 'الربع السابق'] },
  },
  thisYear: {
    granularity: 'year',
    back: 0,
    terms: {
      en: ['this year', 'current year', 'year to date', 'ytd'],
      ar: ['هذا العام', 'هذه السنة', 'العام الحالي', 'السنة الحالية'],
    },
  },
  lastYear: {
    granularity: 'year',
    back: 1,
    terms: { en: ['last year', 'previous year'], ar: ['العام الماضي', 'السنة الماضية', 'العام السابق'] },
  },
};

/** Words that introduce a CI name: "the host named ledger-db", "الخدمة المسماة …". */
export const NAME_MARKERS: Terms = {
  en: ['named', 'called', 'name is'],
  ar: ['اسمه', 'اسمها', 'المسمى', 'المسماة', 'باسم'],
};

/** Words that introduce a scope value: "hosts in Riyadh", "VMs on VMware". */
export const FILTER_MARKERS: Terms = {
  en: ['in', 'at', 'on', 'within', 'inside', 'from', 'running'],
  ar: ['في', 'ضمن', 'داخل', 'على', 'من'],
};

/** Health words mapped to the contract's health states. */
export const HEALTH_TERMS: Record<'healthy' | 'degraded' | 'down', Terms> = {
  // "يعمل" (runs) is not a health word: "كم مضيفًا يعمل بكل نظام تشغيل" asks how many hosts run each OS.
  healthy: {
    en: ['healthy', 'up', 'fine', 'ok'],
    ar: ['سليم', 'سليمة', 'سليمين', 'بصحة جيدة', 'بحالة جيدة'],
  },
  degraded: { en: ['degraded', 'struggling', 'impaired'], ar: ['متدهور', 'متدهورة', 'متأثر', 'ضعيف'] },
  down: {
    en: ['down', 'failed', 'offline', 'outage', 'broken', 'not working'],
    ar: ['معطل', 'معطلة', 'متوقف', 'متوقفة', 'خارج الخدمة', 'لا يعمل', 'لا تعمل'],
  },
};

const ARABIC_DIACRITICS = new RegExp('[\\u064B-\\u0652\\u0670\\u0640]', 'g');
const ARABIC_INDIC_DIGITS = new RegExp('[\\u0660-\\u0669\\u06F0-\\u06F9]', 'g');
const ARABIC_INDIC_ZERO = '٠'.codePointAt(0) ?? 0;
const EXTENDED_ARABIC_INDIC_ZERO = '۰'.codePointAt(0) ?? 0;
const DIGIT_SPAN = '٩'.codePointAt(0) ?? 0;
const PUNCTUATION = new RegExp('[?!؟،,;:()\\[\\]{}«»"“”‘’]', 'g');
const SPACES = new RegExp('\\s+', 'g');
/** Clitic prefixes an Arabic term may carry in a sentence (and, in, with, to, the, as). */
const ARABIC_PREFIXES = ['', 'و', 'ف', 'ب', 'ل', 'ك', 'ال', 'وال', 'بال', 'فال', 'كال', 'لل', 'ولل'];

function asciiDigit(d: string): string {
  const code = d.codePointAt(0) ?? 0;
  const zero = code > DIGIT_SPAN ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO;
  return String(code - zero);
}

/** Arabic-Indic digits to ASCII, the Arabic decimal separator to a point and the Arabic thousands separator to a comma. */
export function asciiDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC_DIGITS, asciiDigit)
    .replace(new RegExp('\\u066B', 'g'), '.')
    .replace(new RegExp('\\u066C', 'g'), ',');
}

/** Lower-cases, strips Arabic diacritics and tatweel, unifies alef, yaa and taa marbuta, maps Arabic-Indic digits. */
export function normalise(text: string): string {
  return asciiDigits(text.toLowerCase())
    .replace(ARABIC_DIACRITICS, '')
    .replace(new RegExp('[أإآٱ]', 'g'), 'ا')
    .replace(new RegExp('ى', 'g'), 'ي')
    .replace(new RegExp('ة', 'g'), 'ه')
    .replace(PUNCTUATION, ' ')
    .replace(SPACES, ' ')
    .trim();
}

export function isArabic(text: string): boolean {
  return new RegExp('[\\u0600-\\u06FF]').test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(new RegExp('[.*+?^${}()|[\\]\\\\]', 'g'), '\\$&');
}

export interface TermHit {
  term: string;
  /** Offset of the term itself (prefix excluded) in the normalised text. */
  index: number;
  /** Length of the matched span including an Arabic prefix or suffix. */
  length: number;
  /** Offset where the matched span starts (prefix included). */
  start: number;
}

/** Whole-word match for Latin terms; Arabic terms allow the clitic prefixes and a few common suffixes. */
export function locateTerm(normalisedText: string, term: string): TermHit | null {
  const t = normalise(term);
  if (t.length === 0) return null;
  const prefixes = '(?:' + ARABIC_PREFIXES.map((p) => escapeRegExp(p)).join('|') + ')';
  // Each word of an Arabic term may carry its own clitic: "خدمات الأعمال" matches the term "خدمات أعمال".
  // ...and its own case or number ending: "جهازا افتراضيا" (accusative) matches the term "جهاز افتراضي".
  const suffixes = '(?:ات|ين|ون|ها|هم|ه|ي|ا|يا|ان)?';
  const arabicBody = t
    .split(' ')
    .map(escapeRegExp)
    .join(suffixes + '\\s+' + prefixes);
  const pattern = isArabic(t)
    ? new RegExp('(^|\\s)(' + prefixes + arabicBody + suffixes + ')(?=\\s|$)')
    : new RegExp('(^|[^a-z0-9])(' + escapeRegExp(t) + ')(?=[^a-z0-9]|$)');
  const m = pattern.exec(normalisedText);
  if (m === null) return null;
  const [, lead = '', span = ''] = m;
  const start = m.index + lead.length;
  const inner = span.indexOf(t);
  return { term, index: inner >= 0 ? start + inner : start, length: span.length, start };
}

export function containsTerm(normalisedText: string, term: string): boolean {
  return locateTerm(normalisedText, term) !== null;
}

/** The longest term of a set that occurs in the text, or null. Longest first so "business service" beats "service". */
export function matchTerms(normalisedText: string, terms: Terms): TermHit | null {
  const all = [...terms.en, ...terms.ar].sort((a, b) => b.length - a.length);
  for (const term of all) {
    const hit = locateTerm(normalisedText, term);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every entry of a catalogue whose terms occur, with the hit, longest term first. */
export function matchCatalogue<K extends string>(
  normalisedText: string,
  catalogue: Readonly<Partial<Record<K, { terms: Terms } | Terms>>>,
): Array<{ key: K; hit: TermHit }> {
  const hits: Array<{ key: K; hit: TermHit }> = [];
  for (const key of Object.keys(catalogue) as K[]) {
    const entry = catalogue[key];
    if (entry === undefined) continue;
    const terms: Terms = 'terms' in entry ? entry.terms : entry;
    const hit = matchTerms(normalisedText, terms);
    if (hit !== null) hits.push({ key, hit });
  }
  return hits.sort((a, b) => b.hit.term.length - a.hit.term.length);
}

/** Blanks a matched span so shorter terms inside it ("host" in "esxi host") are not matched again. */
export function maskSpan(text: string, hit: TermHit): string {
  return text.slice(0, hit.start) + ' '.repeat(hit.length) + text.slice(hit.start + hit.length);
}

/** REQ-AI-008 — a rolling window in a measurement question: "over the last 7 days", "last 24 hours", "آخر 7 أيام". */
export interface RangeSpec {
  hours: number;
  term: string;
}

const RANGE_UNIT_HOURS: ReadonlyArray<{ terms: readonly string[]; hours: number }> = [
  { terms: ['hour', 'hours', 'hr', 'hrs', 'ساعه', 'ساعات', 'ساعتين'], hours: 1 },
  { terms: ['day', 'days', 'يوم', 'ايام', 'يومين'], hours: TIME.hoursPerDay },
  { terms: ['week', 'weeks', 'اسبوع', 'اسابيع', 'اسبوعين'], hours: TIME.hoursPerDay * ASSISTANT.weekDays },
];
const RANGE_LEAD = '(?:over the last|over the past|in the last|in the past|during the last|for the last|last|past|previous|recent|اخر|خلال اخر|خلال|في اخر|على مدى اخر|على مدار اخر)';
const RANGE_NUMBERED = new RegExp(
  '(?:^|\\s)' + RANGE_LEAD + '\\s+([0-9]+)\\s+(' +
    RANGE_UNIT_HOURS.flatMap((u) => u.terms).join('|') +
    ')(?=\\s|$)',
);
/** Word forms without a number: "last week", "past week", "الأسبوع الماضي", "الأسبوع الأخير", "last 24 hours" is numbered. */
const RANGE_WORDS: ReadonlyArray<{ term: string; hours: number }> = [
  { term: 'last week', hours: TIME.hoursPerDay * ASSISTANT.weekDays },
  { term: 'past week', hours: TIME.hoursPerDay * ASSISTANT.weekDays },
  { term: 'previous week', hours: TIME.hoursPerDay * ASSISTANT.weekDays },
  { term: 'الاسبوع الماضي', hours: TIME.hoursPerDay * ASSISTANT.weekDays },
  { term: 'الاسبوع الاخير', hours: TIME.hoursPerDay * ASSISTANT.weekDays },
  { term: 'last 24 hours', hours: TIME.hoursPerDay },
  { term: 'today', hours: TIME.hoursPerDay },
  { term: 'اليوم', hours: TIME.hoursPerDay },
];

/** The rolling window named in a normalised question, or null; the matched span is returned for the evidence. */
export function rangeOf(normalisedText: string): RangeSpec | null {
  const m = RANGE_NUMBERED.exec(normalisedText);
  if (m !== null) {
    const [whole, countText, unitText] = m;
    const count = Number(countText);
    const unit = RANGE_UNIT_HOURS.find((u) => u.terms.includes(unitText ?? ''));
    if (unit !== undefined && Number.isFinite(count) && count > 0)
      return { hours: count * unit.hours, term: whole.trim() };
  }
  for (const w of RANGE_WORDS) {
    const hit = locateTerm(normalisedText, w.term);
    if (hit !== null) return { hours: w.hours, term: w.term };
  }
  return null;
}

/** Words that open a follow-up: "and last month?", "what about VMs?", "وماذا عن الشهر الماضي؟". */
export const CONTINUATION_TERMS: Terms = {
  en: ['and', 'what about', 'how about', 'also', 'same for', 'and for', 'now for', 'then'],
  ar: ['وماذا عن', 'ماذا عن', 'وبالنسبه', 'بالنسبه', 'ايضا', 'كذلك', 'والان', 'ثم'],
};

/** True when the normalised question opens with a continuation word (an Arabic clitic "و" on the first word counts). */
export function startsWithContinuation(normalisedText: string): boolean {
  const first = normalisedText.split(' ')[0] ?? '';
  if (first.length === 0) return false;
  for (const term of [...CONTINUATION_TERMS.en, ...CONTINUATION_TERMS.ar]) {
    const hit = locateTerm(normalisedText, term);
    if (hit !== null && hit.start === 0) return true;
  }
  return isArabic(first) && first.startsWith('و') && first.length > 1;
}
