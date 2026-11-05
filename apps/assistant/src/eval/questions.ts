// REQ-AI-007 (ADR-028) — the checked-in evaluation set: the questions Syed raised and the ones every skill must
// answer, in English and Arabic, each with the intent and skill it must resolve to and whether the estate must
// yield a figure. `pnpm --filter @openmap/api test:integration` runs them through the real pipeline against the
// compose stack and fails under ASSISTANT.evalAccuracyMin; the unit tests run the classification half offline.
import type { Locale } from '@openmap/constants';
import type { AssistantIntent, AssistantSkill, CiType } from '@openmap/contracts';

export interface EvalQuestion {
  id: string;
  locale: Locale;
  /** `{name}` is replaced with the name of a current CI of `nameOf` before the question is asked. */
  question: string;
  nameOf: CiType | null;
  expect: {
    intent: AssistantIntent;
    /** The skill the plan must run first, or null when the right answer is a clarifying question. */
    skill: AssistantSkill | null;
    /** The answer must carry at least one figure above zero (the synthetic estate holds the data). */
    figure: boolean;
    /** A fragment the first evidence query must contain (an attribute key, a metric, a relationship). */
    queryMentions: string | null;
  };
}

export const EVAL_QUESTIONS: readonly EvalQuestion[] = [
  {
    id: 'count-hosts',
    locale: 'en',
    question: 'How many hosts are there?',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'host' },
  },
  {
    id: 'os-per-server',
    locale: 'en',
    question: 'OS per server average',
    nameOf: null,
    expect: { intent: 'attribute_stats', skill: 'cmdb.attributes', figure: true, queryMentions: 'osName' },
  },
  {
    id: 'vm-density-vmware',
    locale: 'en',
    question: 'How many VMs running per host in VMware',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'hosted_on' },
  },
  {
    id: 'avg-memory-hosts',
    locale: 'en',
    question: 'What is the average memory of the hosts?',
    nameOf: null,
    expect: { intent: 'attribute_stats', skill: 'cmdb.attributes', figure: true, queryMentions: 'memoryGb' },
  },
  {
    id: 'hosts-per-os',
    locale: 'en',
    question: 'How many hosts run each operating system?',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'osName' },
  },
  {
    id: 'hosts-per-site',
    locale: 'en',
    question: 'How many hosts per site?',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'site' },
  },
  {
    id: 'vcpus-per-vm',
    locale: 'en',
    question: 'What is the average number of vCPUs per VM?',
    nameOf: null,
    expect: { intent: 'attribute_stats', skill: 'cmdb.attributes', figure: true, queryMentions: 'vcpus' },
  },
  {
    id: 'avg-cpu-hosts',
    locale: 'en',
    question: 'Average CPU utilisation of hosts',
    nameOf: null,
    expect: {
      intent: 'measurement',
      skill: 'metrics.latest',
      figure: true,
      queryMentions: 'host.cpu.utilisation_percent',
    },
  },
  {
    id: 'top-cpu-hosts',
    locale: 'en',
    question: 'Which hosts have the highest CPU utilisation?',
    nameOf: null,
    expect: {
      intent: 'measurement',
      skill: 'metrics.latest',
      figure: true,
      queryMentions: 'host.cpu.utilisation_percent',
    },
  },
  {
    id: 'power-racks',
    locale: 'en',
    question: 'Which PDUs draw the most power?',
    nameOf: null,
    expect: {
      intent: 'measurement',
      skill: 'metrics.latest',
      figure: true,
      queryMentions: 'dcim.power.watts',
    },
  },
  {
    id: 'uptime-month',
    locale: 'en',
    question: 'What is the uptime of business services this month?',
    nameOf: null,
    expect: { intent: 'availability', skill: 'services.availability', figure: true, queryMentions: null },
  },
  {
    id: 'uptime-service',
    locale: 'en',
    question: 'What was the availability of "{name}" last month?',
    nameOf: 'business_service',
    expect: { intent: 'availability', skill: 'services.availability', figure: true, queryMentions: null },
  },
  {
    id: 'open-incidents',
    locale: 'en',
    question: 'Which incidents are open?',
    nameOf: null,
    expect: { intent: 'incidents', skill: 'incidents', figure: false, queryMentions: null },
  },
  {
    id: 'impact-host',
    locale: 'en',
    question: 'Which business services depend on the host named {name}?',
    nameOf: 'host',
    expect: { intent: 'impact', skill: 'impact', figure: true, queryMentions: null },
  },
  {
    id: 'impact-no-name',
    locale: 'en',
    question: 'What is affected if it fails?',
    nameOf: null,
    expect: { intent: 'impact', skill: null, figure: false, queryMentions: null },
  },
  {
    id: 'history-host',
    locale: 'en',
    question: 'What changed on the host {name} recently?',
    nameOf: 'host',
    expect: { intent: 'history', skill: 'history', figure: true, queryMentions: null },
  },
  {
    id: 'howto-subnet',
    locale: 'en',
    question: 'How do I add a subnet?',
    nameOf: null,
    expect: { intent: 'howto', skill: 'howto', figure: false, queryMentions: 'ipam' },
  },
  {
    id: 'services-down',
    locale: 'en',
    question: 'Which business services are down?',
    nameOf: null,
    expect: { intent: 'lookup', skill: 'graph.query', figure: false, queryMentions: 'BusinessService' },
  },
  {
    id: 'racks-most-hosts',
    locale: 'en',
    question: 'Which racks hold the most hosts?',
    nameOf: null,
    expect: { intent: 'lookup', skill: 'graph.query', figure: true, queryMentions: 'Rack' },
  },
  {
    id: 'small-talk',
    locale: 'en',
    question: 'hello there',
    nameOf: null,
    expect: { intent: 'unknown', skill: null, figure: false, queryMentions: null },
  },
  {
    id: 'ar-count-hosts',
    locale: 'ar',
    question: 'كم عدد المضيفين؟',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'host' },
  },
  {
    id: 'ar-avg-memory',
    locale: 'ar',
    question: 'ما متوسط الذاكرة للمضيفين؟',
    nameOf: null,
    expect: { intent: 'attribute_stats', skill: 'cmdb.attributes', figure: true, queryMentions: 'memoryGb' },
  },
  {
    id: 'ar-vm-density',
    locale: 'ar',
    question: 'كم جهازاً افتراضياً لكل مضيف؟',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'hosted_on' },
  },
  {
    id: 'ar-uptime',
    locale: 'ar',
    question: 'ما هو توافر خدمات الأعمال هذا الشهر؟',
    nameOf: null,
    expect: { intent: 'availability', skill: 'services.availability', figure: true, queryMentions: null },
  },
  {
    id: 'ar-incidents',
    locale: 'ar',
    question: 'أي الحوادث مفتوحة؟',
    nameOf: null,
    expect: { intent: 'incidents', skill: 'incidents', figure: false, queryMentions: null },
  },
  {
    id: 'ar-howto-subnet',
    locale: 'ar',
    question: 'كيف أضيف شبكة فرعية؟',
    nameOf: null,
    expect: { intent: 'howto', skill: 'howto', figure: false, queryMentions: 'ipam' },
  },
  {
    id: 'ar-avg-cpu',
    locale: 'ar',
    question: 'متوسط استخدام المعالج للمضيفين',
    nameOf: null,
    expect: {
      intent: 'measurement',
      skill: 'metrics.latest',
      figure: true,
      queryMentions: 'host.cpu.utilisation_percent',
    },
  },
  {
    id: 'ar-services-down',
    locale: 'ar',
    question: 'أي خدمات الأعمال معطلة؟',
    nameOf: null,
    expect: { intent: 'lookup', skill: 'graph.query', figure: false, queryMentions: 'BusinessService' },
  },
  {
    id: 'ar-hosts-per-os',
    locale: 'ar',
    question: 'كم مضيفًا يعمل بكل نظام تشغيل؟',
    nameOf: null,
    expect: { intent: 'count', skill: 'cmdb.attributes', figure: true, queryMentions: 'osName' },
  },
];
