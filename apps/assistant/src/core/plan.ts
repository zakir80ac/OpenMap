// REQ-AI-007 REQ-AI-008 (ADR-028) — level two: plan. A classification becomes a short list of skill steps with validated
// parameters, or a clarifying question when the plan would otherwise have to guess (an impact question with no
// CI named, an intent nothing in the catalogue explains). Every rule here is deterministic and unit-tested; the
// skills themselves run in the API against the stores.
import { ASSISTANT, TIME } from '@openmap/constants';
import { ANOMALY_RULES, type AnomalyRule, type CiType } from '@openmap/contracts';
import type { Classification } from './intent.js';
import {
  HOWTO_TOPICS,
  type Clarification,
  type HowtoTopic,
  type ImpactDirection,
  type Plan,
  type PlanStep,
} from './types.js';
import {
  ATTRIBUTE_FAMILIES,
  INTENT_TERMS,
  MEASUREMENTS,
  containsTerm,
  matchTerms,
  type Terms,
} from './vocabulary.js';

/** Which screen a how-to question is about, by the words it uses. */
export const HOWTO_TERMS: Record<HowtoTopic, Terms> = {
  cmdb: {
    en: [
      'ci',
      'cis',
      'configuration item',
      'cmdb',
      'label',
      'unknown device',
      'unknown devices',
      'attribute',
      'attributes',
      'relationship',
    ],
    ar: [
      'عنصر تكوين',
      'عناصر التكوين',
      'cmdb',
      'تسمية',
      'جهاز غير معروف',
      'أجهزة غير معروفة',
      'سمة',
      'سمات',
      'علاقة',
    ],
  },
  ipam: {
    en: ['subnet', 'subnets', 'ip', 'ips', 'ip address', 'dhcp', 'dns', 'vlan', 'ipam', 'free address'],
    ar: ['شبكة فرعية', 'شبكات فرعية', 'عنوان ip', 'dhcp', 'dns', 'vlan', 'ipam', 'عنوان حر'],
  },
  dcim: {
    en: ['rack', 'racks', 'power', 'pdu', 'cooling', 'cabling', 'elevation', 'dcim', 'floor plan'],
    ar: ['رف', 'رفوف', 'طاقة', 'pdu', 'تبريد', 'كابلات', 'dcim', 'مخطط الطابق'],
  },
  assets: {
    en: [
      'asset',
      'assets',
      'register',
      'warranty',
      'licence',
      'license',
      'subscription',
      'support contract',
      'end of life',
      'plan',
      'bom',
    ],
    ar: ['أصل', 'أصول', 'سجل الأصول', 'ضمان', 'رخصة', 'ترخيص', 'اشتراك', 'عقد دعم', 'نهاية العمر', 'خطة'],
  },
  services: {
    en: ['service', 'services', 'sla', 'incident', 'incidents', 'rca', 'uptime', 'availability', 'health'],
    ar: ['خدمة', 'خدمات', 'اتفاقية مستوى الخدمة', 'حادث', 'حوادث', 'السبب الجذري', 'التوافر', 'الصحة'],
  },
  impact: {
    en: ['impact', 'scenario', 'what if', 'simulation', 'dependency', 'dependencies', 'blast radius'],
    ar: ['تأثير', 'سيناريو', 'ماذا لو', 'محاكاة', 'اعتمادية', 'اعتماديات'],
  },
  discovery: {
    en: [
      'discovery',
      'discover',
      'collector',
      'collectors',
      'node',
      'nodes',
      'sweep',
      'credential',
      'credentials',
      'scope',
      'snmp',
    ],
    ar: ['اكتشاف', 'الاكتشاف', 'مجمع', 'مجمعات', 'عقدة', 'عقد', 'مسح', 'بيانات اعتماد', 'نطاق'],
  },
  dashboards: {
    en: ['dashboard', 'dashboards', 'widget', 'widgets', 'tile', 'tiles', 'kpi'],
    ar: ['لوحة', 'لوحات', 'لوحة المعلومات', 'عنصر واجهة', 'بلاطة', 'مؤشر'],
  },
  settings: {
    en: [
      'setting',
      'settings',
      'tenant',
      'role',
      'roles',
      'user',
      'users',
      'locale',
      'language',
      'arabic',
      'audit',
    ],
    ar: ['إعداد', 'إعدادات', 'مستأجر', 'دور', 'أدوار', 'مستخدم', 'مستخدمين', 'اللغة', 'العربية', 'تدقيق'],
  },
  assistant: {
    en: ['assistant', 'ask', 'question', 'questions', 'chat', 'you'],
    ar: ['مساعد', 'المساعد', 'سؤال', 'أسئلة', 'محادثة', 'أنت'],
  },
  reports: {
    en: ['report', 'reports', 'export', 'csv', 'analytics', 'superset', 'download'],
    ar: ['تقرير', 'تقارير', 'تصدير', 'csv', 'تحليلات', 'تحميل'],
  },
  layers: {
    en: ['layer', 'layers', 'stack', 'twin', 'map', 'topology', 'graph'],
    ar: ['طبقة', 'طبقات', 'المكدس', 'التوأم', 'خريطة', 'طوبولوجيا', 'الرسم'],
  },
};

/** "VMs per host" means the hypervisor the VM is hosted on; the person's word is kept, the counterpart corrected. */
const COUNTERPART_ALIAS: Partial<Record<CiType, Partial<Record<CiType, CiType>>>> = {
  vm: { host: 'hypervisor' },
  container: { host: 'k8s_workload' },
};

/** Words meaning the incidents asked for are the closed ones. */
const CLOSED_TERMS: Terms = {
  en: ['closed', 'resolved', 'past', 'historical', 'last month', 'last week'],
  ar: ['مغلقة', 'المغلقة', 'محلولة', 'المحلولة', 'السابقة', 'الماضية'],
};
/** REQ-AI-006: words that narrow an anomaly question to one rule (ADR-053). */
const ANOMALY_RULE_TERMS: Record<AnomalyRule, Terms> = {
  ip_conflict: { en: ['ip conflict', 'ip conflicts', 'address conflict', 'address conflicts', 'duplicate ip', 'duplicate ips', 'same ip', 'same address'], ar: ['تعارض عنوان', 'تعارض العناوين', 'عنوان مكرر', 'عناوين مكررة', 'نفس العنوان'] },
  unmanaged_device_in_datacenter: { en: ['unmanaged', 'rogue', 'unknown device', 'unknown devices', 'unidentified'], ar: ['غير مدار', 'غير مدارة', 'مجهول', 'مجهولة', 'غير معروف'] },
  flapping_service: { en: ['flapping', 'flap', 'unstable service', 'unstable services', 'keeps failing'], ar: ['متذبذبة', 'متذبذب', 'تذبذب', 'غير مستقرة'] },
};

function anomalyRuleOf(text: string): AnomalyRule | null {
  for (const rule of ANOMALY_RULES) if (matchTerms(text, ANOMALY_RULE_TERMS[rule]) !== null) return rule;
  return null;
}

/** "What does X depend on" walks downstream; "what depends on X" walks upstream. */
const DOWNSTREAM_TERMS: Terms = {
  en: ['what does', 'which does', 'rely on', 'relies on', 'built on', 'underneath', 'depend on?'],
  ar: ['على ماذا يعتمد', 'على ماذا تعتمد', 'يعتمد عليها', 'تعتمد عليه', 'ماذا يحتاج'],
};

export function howtoTopic(normalised: string): HowtoTopic {
  let best: { topic: HowtoTopic; length: number } | null = null;
  for (const topic of HOWTO_TOPICS) {
    if (topic === 'assistant') continue;
    const hit = matchTerms(normalised, HOWTO_TERMS[topic]);
    if (hit !== null && (best === null || hit.term.length > best.length))
      best = { topic, length: hit.term.length };
  }
  return best?.topic ?? 'assistant';
}

function needName(): Clarification {
  return { key: 'assistant.clarify.needName', params: {}, options: [] };
}

export function unknownClarification(): Clarification {
  return {
    key: 'assistant.clarify.unknown',
    params: {},
    options: [
      { key: 'assistant.example.hosts' },
      { key: 'assistant.example.memory' },
      { key: 'assistant.example.cpu' },
      { key: 'assistant.example.uptime' },
      { key: 'assistant.example.incidents' },
    ],
  };
}

function steps(...list: PlanStep[]): Plan {
  return { steps: list, clarification: null };
}

function clarify(clarification: Clarification): Plan {
  return { steps: [], clarification };
}

function graph(question: string): Plan {
  return steps({ skill: 'graph.query', question });
}

export function plan(c: Classification, question: string): Plan {
  const e = c.entities;
  const subject = e.types[0] ?? null;
  const topN = e.topN ?? ASSISTANT.topN;
  switch (c.intent) {
    case 'howto':
      return steps({ skill: 'howto', topic: howtoTopic(c.normalised) });
    case 'report': {
      if (matchTerms(c.normalised, INTENT_TERMS.availability) !== null)
        return steps({
          skill: 'services.availability',
          granularity: e.period?.granularity ?? 'month',
          back: e.period?.back ?? 0,
          names: e.names,
        });
      return steps({ skill: 'howto', topic: 'reports' });
    }
    case 'availability':
      return steps({
        skill: 'services.availability',
        granularity: e.period?.granularity ?? 'month',
        back: e.period?.back ?? 0,
        names: e.names,
      });
    case 'incidents':
      return steps({
        skill: 'incidents',
        open: matchTerms(c.normalised, CLOSED_TERMS) === null,
        names: e.names,
      });
    case 'anomalies':
      return steps({ skill: 'anomalies', rule: anomalyRuleOf(c.normalised) });
    case 'impact': {
      if (e.names.length === 0) return clarify(needName());
      const direction: ImpactDirection =
        matchTerms(c.normalised, DOWNSTREAM_TERMS) !== null ? 'downstream' : 'upstream';
      return steps({ skill: 'impact', names: e.names, direction });
    }
    case 'history':
      if (e.names.length === 0) return clarify(needName());
      return steps({ skill: 'history', names: e.names, period: e.period });
    case 'measurement': {
      if (e.measurement === null) return graph(question);
      const type: CiType = subject ?? MEASUREMENTS[e.measurement].subjects[0];
      // REQ-AI-008: a window ("over the last 7 days") or a calendar period ("last month", read as a rolling window
      // of the same length) asks for the series; otherwise the latest sample answers.
      const window = windowOf(e);
      if (window !== null)
        return steps({
          skill: 'metrics.series',
          metric: e.measurement,
          type,
          aggregate: e.aggregate ?? 'avg',
          names: e.names,
          filters: e.filters,
          hours: window.hours,
          offsetHours: window.offsetHours,
        });
      return steps({
        skill: 'metrics.latest',
        metric: e.measurement,
        type,
        aggregate: e.aggregate ?? 'avg',
        names: e.names,
        filters: e.filters,
        topN,
      });
    }
    case 'attribute_stats': {
      if (subject === null || e.attribute === null) return graph(question);
      const numeric = ATTRIBUTE_FAMILIES[e.attribute].numeric;
      const asked = e.aggregate;
      const aggregate =
        asked === null || asked === 'count'
          ? numeric
            ? 'avg'
            : 'distribution'
          : numeric
            ? asked
            : 'distribution';
      return steps({
        skill: 'cmdb.attributes',
        type: subject,
        aggregate,
        family: e.attribute,
        groupBy: e.groupBy,
        filters: e.filters,
        health: e.health,
        topN,
      });
    }
    case 'count': {
      if (e.health !== null) return graph(question);
      const type = subject ?? (e.groupBy?.kind === 'type' ? e.groupBy.type : null);
      if (type === null) return graph(question);
      let groupBy = e.groupBy;
      if (groupBy?.kind === 'type') {
        const alias = COUNTERPART_ALIAS[type]?.[groupBy.type];
        if (alias !== undefined) groupBy = { kind: 'type', type: alias };
      }
      return steps({
        skill: 'cmdb.attributes',
        type,
        aggregate: 'count',
        family: null,
        groupBy,
        filters: e.filters,
        health: null,
        topN,
      });
    }
    case 'lookup':
      return graph(question);
    case 'unknown':
      return clarify(unknownClarification());
  }
}

/** The rolling window a measurement question asks for: an explicit range, or a calendar period of the same length. */
export function windowOf(e: Classification['entities']): { hours: number; offsetHours: number } | null {
  if (e.range !== null) return { hours: e.range.hours, offsetHours: 0 };
  if (e.period !== null) {
    const hours = ASSISTANT.rollingDays[e.period.granularity] * TIME.hoursPerDay;
    return { hours, offsetHours: e.period.back * hours };
  }
  return null;
}

/** True when the question is plainly outside the estate (greetings, chit-chat), so no skill should run. */
export function isSmallTalk(normalised: string): boolean {
  const greetings: Terms = {
    en: ['hello', 'hi', 'hey', 'thanks', 'thank you', 'good morning', 'good evening'],
    ar: ['مرحبا', 'اهلا', 'أهلا', 'شكرا', 'صباح الخير', 'مساء الخير', 'السلام عليكم'],
  };
  return (
    normalised.split(' ').length <= ASSISTANT.smallTalkMaxWords &&
    [...greetings.en, ...greetings.ar].some((g) => containsTerm(normalised, g))
  );
}
