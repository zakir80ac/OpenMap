// T-142 REQ-AI-007 — the conversational levels offline: the classifier reads English and Arabic questions into the
// intended intent and entities (every evaluation-set question included), the planner turns them into the expected
// skill or clarification, the composer words every summary kind in both locales with its figures, the grounding
// guard rejects invented numbers and names, and the model's verdict only fills gaps.
import { describe, expect, it } from 'vitest';
import { ASSISTANT, LOCALES } from '@openmap/constants';
import { createTranslator } from '@openmap/i18n';
import { composeAll, composeSummary, formatNumber, listItems } from './compose.js';
import { EVAL_QUESTIONS } from '../eval/questions.js';
import { suggestFollowUps } from './followups.js';
import { checkGrounding, numbersIn, sentenceCount } from './guard.js';
import { classify } from './intent.js';
import { applyVerdict, parseVerdict } from './llm-intent.js';
import { howtoTopic, isSmallTalk, plan } from './plan.js';
import { extractProse, proseMessages } from './prose.js';
import type { Summary } from './types.js';
import { containsTerm, locateTerm, normalise } from './vocabulary.js';

describe('vocabulary', () => {
  it('normalises Arabic diacritics, alef forms and Arabic-Indic digits', () => {
    expect(normalise('أَجْهِزَة ٱفتراضية ٣٠')).toBe('اجهزه افتراضيه 30');
    expect(normalise('Hosts, in RYD?')).toBe('hosts in ryd');
  });
  it('matches Latin terms on word boundaries and Arabic terms with clitic prefixes', () => {
    expect(containsTerm('how many hosts', 'host')).toBe(false);
    expect(containsTerm('how many hosts', 'hosts')).toBe(true);
    expect(containsTerm('the hostname of x', 'host')).toBe(false);
    expect(containsTerm(normalise('كم عدد المضيفين'), 'مضيفين')).toBe(true);
    expect(containsTerm(normalise('توافر خدمات الأعمال'), 'خدمات اعمال')).toBe(true);
    expect(locateTerm('esxi host count', 'esxi host')?.start).toBe(0);
  });
});

describe('classify', () => {
  it('reads "OS per server average" as attribute statistics over the operating system of hosts', () => {
    const c = classify('OS per server average');
    expect(c.intent).toBe('attribute_stats');
    expect(c.entities.types).toEqual(['host']);
    expect(c.entities.attribute).toBe('os');
    expect(c.entities.groupBy).toBeNull();
    expect(c.locale).toBe('en');
  });
  it('reads VM density per host in VMware as a count grouped by the counterpart type with a scope filter', () => {
    const c = classify('How many VMs running per host in VMware');
    expect(c.intent).toBe('count');
    expect(c.entities.types[0]).toBe('vm');
    expect(c.entities.groupBy).toEqual({ kind: 'type', type: 'host' });
    expect(c.entities.filters).toEqual(['vmware']);
    expect(c.entities.aggregate).toBe('count');
  });
  it('tells a measurement from an attribute and picks the metric for the subject type', () => {
    expect(classify('Average CPU utilisation of hosts').entities.measurement).toBe(
      'host.cpu.utilisation_percent',
    );
    expect(classify('Which VMs have the highest CPU usage?').entities.measurement).toBe(
      'vm.cpu.utilisation_percent',
    );
    expect(classify('Which PDUs draw the most power?').entities.measurement).toBe('dcim.power.watts');
    const memory = classify('What is the average memory of the hosts?');
    expect(memory.intent).toBe('attribute_stats');
    expect(memory.entities.attribute).toBe('memory');
    expect(memory.entities.aggregate).toBe('avg');
  });
  it('finds names in quotes, code-like tokens and after "named"', () => {
    expect(classify('Which business services depend on the host named ledger-db?').entities.names).toEqual([
      'ledger-db',
    ]);
    expect(classify('What changed on srv-dmm-hadoop-0180 recently?').entities.names).toEqual([
      'srv-dmm-hadoop-0180',
    ]);
    expect(classify('What was the availability of "Online banking" last month?').entities.names).toEqual([
      'Online banking',
    ]);
    expect(classify('How many hosts are there?').entities.names).toEqual([]);
  });
  it('reads periods, health and top-N', () => {
    expect(classify('uptime of services last quarter').entities.period?.granularity).toBe('quarter');
    expect(classify('uptime of services last quarter').entities.period?.back).toBe(1);
    expect(classify('which business services are down').entities.health).toBe('down');
    expect(classify('top 5 hosts by cpu utilisation').entities.topN).toBe(5);
  });
  it('reads Arabic questions into the same intents', () => {
    expect(classify('كم عدد المضيفين؟').intent).toBe('count');
    expect(classify('ما متوسط الذاكرة للمضيفين؟').entities.attribute).toBe('memory');
    expect(classify('ما هو توافر خدمات الأعمال هذا الشهر؟').intent).toBe('availability');
    expect(classify('كيف أضيف شبكة فرعية؟').intent).toBe('howto');
    expect(classify('كم عدد المضيفين؟').locale).toBe('ar');
  });
  it('classifies and plans every evaluation question as the set expects', () => {
    for (const q of EVAL_QUESTIONS) {
      const question = q.question.replace('{name}', 'sample-ci-01');
      const c = classify(question);
      const p = plan(c, question);
      const first = p.steps[0];
      const skill = isSmallTalk(c.normalised) ? null : (first?.skill ?? null);
      expect({ id: q.id, intent: c.intent, skill }).toEqual({
        id: q.id,
        intent: q.expect.intent,
        skill: q.expect.skill,
      });
      expect(c.locale, q.id).toBe(q.locale);
      if (q.expect.skill !== null)
        expect(c.confidence, q.id).toBeGreaterThanOrEqual(ASSISTANT.minIntentConfidence);
    }
  });
});

describe('plan', () => {
  it('maps the counterpart "host" of a VM to the hypervisor and keeps the scope filter', () => {
    const p = plan(
      classify('How many VMs running per host in VMware'),
      'How many VMs running per host in VMware',
    );
    expect(p.steps[0]).toMatchObject({
      skill: 'cmdb.attributes',
      type: 'vm',
      aggregate: 'count',
      groupBy: { kind: 'type', type: 'hypervisor' },
      filters: ['vmware'],
    });
  });
  it('asks for a name before an impact or history question runs, and asks what was meant when nothing matched', () => {
    expect(plan(classify('what is affected if it fails'), '').clarification?.key).toBe(
      'assistant.clarify.needName',
    );
    expect(plan(classify('zzz qqq'), '').clarification?.key).toBe('assistant.clarify.unknown');
  });
  it('turns a non-numeric attribute into a breakdown and a numeric one into the asked aggregate', () => {
    expect(plan(classify('OS per server average'), '').steps[0]).toMatchObject({
      skill: 'cmdb.attributes',
      family: 'os',
      aggregate: 'distribution',
    });
    expect(plan(classify('total memory of VMs'), '').steps[0]).toMatchObject({
      skill: 'cmdb.attributes',
      family: 'memory',
      aggregate: 'sum',
    });
    expect(plan(classify('maximum vcpus per vm'), '').steps[0]).toMatchObject({
      skill: 'cmdb.attributes',
      type: 'vm',
      family: 'cpu',
      aggregate: 'max',
      groupBy: null,
    });
  });
  it('routes health questions and open-ended lookups to the graph', () => {
    expect(plan(classify('how many hosts are down'), 'how many hosts are down').steps[0]?.skill).toBe(
      'graph.query',
    );
    expect(plan(classify('which racks hold the most hosts'), 'q').steps[0]?.skill).toBe('graph.query');
  });
  it('finds the how-to topic by the screen words', () => {
    expect(howtoTopic(normalise('How do I add a subnet?'))).toBe('ipam');
    expect(howtoTopic(normalise('How do I assign an SLA to a service?'))).toBe('services');
    expect(howtoTopic(normalise('How do I rack a server?'))).toBe('dcim');
    expect(howtoTopic(normalise('what can you do'))).toBe('assistant');
  });
});

const summaries: Summary[] = [
  { kind: 'count', type: 'host', count: 2000, filters: [], health: null },
  {
    kind: 'groups',
    type: 'host',
    dimension: { kind: 'attribute', family: 'os', key: 'osName' },
    groups: [
      { label: 'RHEL 9', count: 1200, value: null },
      { label: 'Windows Server 2022', count: 800, value: null },
    ],
    total: 2000,
    filters: [],
    unit: '',
  },
  {
    kind: 'aggregate',
    type: 'host',
    family: 'memory',
    key: 'memoryGb',
    aggregate: 'avg',
    value: 254.5,
    unit: 'GB',
    count: 2000,
    filters: ['ryd'],
  },
  {
    kind: 'density',
    type: 'vm',
    counterpart: 'hypervisor',
    relationship: 'hosted_on',
    avg: 12,
    max: 24,
    groups: 125,
    total: 1500,
    filters: ['vmware'],
  },
  {
    kind: 'measurement',
    metric: 'host.cpu.utilisation_percent',
    type: 'host',
    aggregate: 'avg',
    value: 48.34,
    unit: '%',
    count: 4013,
    asOf: '2026-11-05T10:00:00.000Z',
    ranked: [],
    filters: [],
  },
  {
    kind: 'measurement',
    metric: 'host.cpu.utilisation_percent',
    type: 'host',
    aggregate: 'max',
    value: null,
    unit: '%',
    count: 4013,
    asOf: '2026-11-05T10:00:00.000Z',
    ranked: [{ ciId: 'a', name: 'srv-01', value: 97.2 }],
    filters: [],
  },
  {
    kind: 'availability',
    granularity: 'month',
    back: 0,
    periodStart: '2026-11-01',
    lines: [
      {
        ciId: 's1',
        name: 'Online banking',
        availabilityPercent: 99.95,
        downtimeMinutes: 3,
        targetPercent: 99.9,
        met: true,
      },
      {
        ciId: 's2',
        name: 'Payments',
        availabilityPercent: 98.5,
        downtimeMinutes: 90,
        targetPercent: 99.9,
        met: false,
      },
    ],
    estatePercent: 99.2,
    belowTarget: 1,
    downtimeMinutes: 93,
  },
  {
    kind: 'availability',
    granularity: 'month',
    back: 1,
    periodStart: '2026-10-01',
    lines: [
      {
        ciId: 's1',
        name: 'Online banking',
        availabilityPercent: 99.95,
        downtimeMinutes: 3,
        targetPercent: null,
        met: null,
      },
    ],
    estatePercent: 99.95,
    belowTarget: 0,
    downtimeMinutes: 3,
  },
  {
    kind: 'incidents',
    open: true,
    lines: [
      { id: 'i1', title: 'Core switch down', severity: 'critical', state: 'open', serviceName: 'Payments' },
    ],
    scopeName: null,
  },
  { kind: 'incidents', open: true, lines: [], scopeName: 'Payments' },
  {
    kind: 'impact',
    root: { ciId: 'h1', name: 'ledger-db' },
    direction: 'upstream',
    services: [{ ciId: 's1', name: 'Online banking', predicted: 'down' }],
    down: 1,
    degraded: 0,
    nodes: 7,
  },
  {
    kind: 'impact',
    root: { ciId: 'h1', name: 'ledger-db' },
    direction: 'upstream',
    services: [],
    down: 0,
    degraded: 0,
    nodes: 0,
  },
  {
    kind: 'history',
    ci: { ciId: 'h1', name: 'ledger-db' },
    versions: 3,
    latestAt: '2026-11-04T08:00:00.000Z',
    changedKeys: ['memoryGb'],
  },
  { kind: 'history', ci: { ciId: 'h1', name: 'ledger-db' }, versions: 0, latestAt: null, changedKeys: [] },
  { kind: 'howto', topic: 'ipam' },
  { kind: 'graph', rows: [{ name: 'a' }, { name: 'b' }], truncated: false },
  { kind: 'graph', rows: [{ hosts: 3 }], truncated: false },
  { kind: 'graph', rows: [], truncated: false },
  { kind: 'unresolvedFilter', value: 'atlantis' },
];

describe.each(LOCALES)('compose (%s)', (locale) => {
  const t = createTranslator(locale);
  it('words every summary kind without leaving a placeholder and lists its figures', () => {
    for (const s of summaries) {
      const c = composeSummary(s, t, locale);
      expect(c.text, s.kind).not.toMatch(/\{\w+\}/);
      expect(c.text.length, s.kind).toBeGreaterThan(0);
      for (const f of c.figures) expect(Number.isFinite(f.value), s.kind).toBe(true);
    }
    const count = composeSummary(summaries[0] as Summary, t, locale);
    expect(count.text).toContain(formatNumber(locale, 2000));
    expect(count.figures[0]?.value).toBe(2000);
  });
  it('joins several summaries and words a failed step with its reason', () => {
    const all = composeAll(
      [
        { summary: summaries[0] ?? null, error: null },
        { summary: null, error: 'timed out' },
      ],
      t,
      locale,
    );
    expect(all.text).toContain('timed out');
    expect(all.figures).toHaveLength(1);
    expect(composeAll([], t, locale).text).toBe(t('assistant.answer.none'));
    expect(listItems(t, ['a', 'b', 'c'], 2)).toContain(t('assistant.answer.more', { count: 1 }));
  });
  it('suggests up to three follow-ups that differ from the question', () => {
    const c = classify(locale === 'ar' ? 'كم عدد المضيفين؟' : 'How many hosts are there?');
    const f = suggestFollowUps(c, [summaries[0] ?? null], t);
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(ASSISTANT.followUps);
    expect(new Set(f).size).toBe(f.length);
  });
});

describe('grounding guard', () => {
  const figures = [
    { label: 'hosts', value: 2000, unit: '' },
    { label: 'average memory', value: 254.5, unit: 'GB' },
  ];
  const context = {
    figures,
    rows: [{ name: 'srv-01', value: 97.2 }],
    names: ['srv-01', 'ledger-db'],
    question: 'How many hosts have more than 100 GB?',
  };
  it('parses numbers in both scripts and with separators', () => {
    expect(numbersIn('2,000 hosts and 254.5 GB')).toEqual([2000, 254.5]);
    expect(numbersIn('٢٠٠٠ مضيف و٢٥٤٫٥')).toEqual([2000, 254.5]);
    expect(sentenceCount('One. Two! Three?')).toBe(3);
    expect(sentenceCount('No end')).toBe(1);
  });
  it('accepts prose whose numbers and identifiers are in the evidence, at any rounding', () => {
    expect(
      checkGrounding(
        'There are 2,000 hosts with an average of 255 GB of memory; srv-01 is the busiest.',
        context,
      ).ok,
    ).toBe(true);
    expect(checkGrounding('About 254.5 GB on average, over the 100 GB asked.', context).ok).toBe(true);
  });
  it('rejects invented numbers, unknown identifiers, empty text and too many sentences', () => {
    expect(checkGrounding('There are 2,100 hosts.', context).reason).toMatch(/number 2100/);
    expect(checkGrounding('ledger-db and web-77 are affected.', context).reason).toMatch(/identifier web-77/);
    expect(checkGrounding('', context).ok).toBe(false);
    expect(checkGrounding('A. B. C. D. E. F. G.', context).reason).toMatch(/sentences/);
  });
});

describe('model prompts', () => {
  it('builds a prose prompt carrying the deterministic text and parses a fenced reply', () => {
    const messages = proseMessages({
      question: 'q',
      locale: 'ar',
      deterministicText: 'يوجد 2,000 مضيف.',
      figures: [],
      summaries: [summaries[0] ?? null],
    });
    expect(messages[0]?.content).toContain('Arabic');
    expect(messages[1]?.content).toContain('2,000');
    expect(extractProse('```text\nAnswer: There are 2,000 hosts.\n```')).toBe('There are 2,000 hosts.');
  });
  it('parses an intent verdict strictly and lets it fill only what the catalogue left open', () => {
    expect(parseVerdict('sure! {"intent":"count","confidence":0.9,"type":"host"} ok')).toMatchObject({
      intent: 'count',
      type: 'host',
    });
    expect(parseVerdict('{"intent":"guess","confidence":2}')).toBeNull();
    expect(parseVerdict('no json')).toBeNull();
    const unknown = classify('zzz qqq');
    const filled = applyVerdict(unknown, { intent: 'count', confidence: 0.9, type: 'host' });
    expect(filled.intent).toBe('count');
    expect(filled.entities.types).toEqual(['host']);
    expect(filled.matched).toContain('llm:count');
    const confident = classify('How many hosts are there?');
    expect(applyVerdict(confident, { intent: 'impact', confidence: 1 })).toBe(confident);
  });
});
