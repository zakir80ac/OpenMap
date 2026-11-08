// T-511 REQ-AI-006 (ADR-053) — anomaly questions in the conversational assistant:
// - "which anomalies are open" and its Arabic form classify as the anomalies intent and plan the anomalies skill;
// - naming a rule (IP conflicts, unmanaged devices, flapping services) narrows the skill to it;
// - the answer lists each finding through its rule's template, with the count as a figure, in en and ar.
import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '@openmap/i18n';
import { composeSummary } from './compose.js';
import { classify } from './intent.js';
import { plan } from './plan.js';
import type { Summary } from './types.js';

function planOf(question: string) {
  return plan(classify(question), question);
}

describe('anomaly questions', () => {
  it.each([
    ['Which anomalies are open?', null],
    ['Are there any IP conflicts?', 'ip_conflict'],
    ['Show unmanaged devices in the data centre', 'unmanaged_device_in_datacenter'],
    ['Any flapping services?', 'flapping_service'],
    ['ما الحالات الشاذة المفتوحة؟', null],
    ['هل يوجد تعارض عنوان؟', 'ip_conflict'],
  ])('plans %s as the anomalies skill (rule %s)', (question, rule) => {
    expect(classify(question).intent).toBe('anomalies');
    expect(planOf(question).steps).toEqual([{ skill: 'anomalies', rule }]);
  });

  it.each(['en', 'ar'] as Locale[])('lists the findings through their templates in %s', (locale) => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
    const summary: Summary = {
      kind: 'anomalies',
      rule: null,
      lines: [
        { id: '1', rule: 'ip_conflict', subject: '10.50.0.10', facts: { address: '10.50.0.10', claimants: 'ahv-hq-c01-01 (host), iot_sensor-b6ff (unknown)' } },
        { id: '2', rule: 'flapping_service', subject: 'SARIE Instant Payments', facts: { service: 'SARIE Instant Payments', changes: '8', windowHours: '6' } },
      ],
    };
    const c = composeSummary(summary, t, locale);
    expect(c.text).toContain('10.50.0.10');
    expect(c.text).toContain('ahv-hq-c01-01 (host), iot_sensor-b6ff (unknown)');
    expect(c.text).toContain('SARIE Instant Payments');
    expect(c.figures).toEqual([{ label: translate(locale, 'assistant.answer.anomaliesLabel'), value: 2, unit: '' }]);
    expect(composeSummary({ kind: 'anomalies', rule: null, lines: [] }, t, locale).text).toBe(translate(locale, 'assistant.answer.anomaliesNone'));
  });
});
