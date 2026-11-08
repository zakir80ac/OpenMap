// REQ-AI-007 REQ-AI-008 (ADR-028) — level four: compose, the deterministic half. Every skill summary has a wording in both
// locales through the message catalogue, with the figures the sentence rests on listed beside it. The model's prose,
// when enabled, is checked against these figures by the grounding guard and falls back to this text.
import { ASSISTANT, TIME, type Locale } from '@openmap/constants';
import type { AnomalyRule, AssistantAggregate, AssistantFigure, AssistantIntent, CiType } from '@openmap/contracts';
import { isMessageKey, type MessageKey, type Params } from '@openmap/i18n';
import type { AvailabilityLine, GroupCount, HowtoTopic, Summary } from './types.js';
import { MEASUREMENTS, type AttributeFamilyId, type MeasurementName } from './vocabulary.js';

export type Translate = (key: MessageKey, params?: Params) => string;

export interface Composed {
  text: string;
  figures: AssistantFigure[];
}

export function formatNumber(locale: Locale, value: number, decimals = ASSISTANT.decimals): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(value);
}

export function formatDate(locale: Locale, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

function keyOr(key: string, fallback: string, t: Translate): string {
  return isMessageKey(key) ? t(key) : fallback;
}

export function typeLabel(t: Translate, type: CiType): string {
  return keyOr('assistant.type.' + type, type.replaceAll('_', ' '), t);
}

export function attributeLabel(t: Translate, family: AttributeFamilyId): string {
  return keyOr('assistant.attribute.' + family, family, t);
}

export function metricLabel(t: Translate, metric: MeasurementName): string {
  return keyOr('assistant.measurement.' + metric.replaceAll('.', '_'), metric, t);
}

export function aggregateLabel(t: Translate, aggregate: AssistantAggregate): string {
  return keyOr('assistant.aggregate.' + aggregate, aggregate, t);
}

export function intentLabel(t: Translate, intent: AssistantIntent): string {
  return keyOr('assistant.intent.' + intent, intent, t);
}

function periodLabel(t: Translate, granularity: 'month' | 'quarter' | 'year', back: number): string {
  const when = back === 0 ? t('assistant.period.current') : t('assistant.period.previous');
  return t(`assistant.period.${granularity}`, { when });
}

/** "the last 7 days", "the last 36 hours", or "the 30 days ending <date>" when the window does not reach now. */
function windowLabel(t: Translate, locale: Locale, hours: number, to: string): string {
  const days = hours / TIME.hoursPerDay;
  const endsNow = Date.now() - new Date(to).getTime() < TIME.msPerDay;
  if (!endsNow)
    return t('assistant.range.ending', { count: formatNumber(locale, Math.round(days)), to: formatDate(locale, to) });
  return Number.isInteger(days) && days >= 1
    ? t('assistant.range.days', { count: formatNumber(locale, days) })
    : t('assistant.range.hours', { count: formatNumber(locale, hours) });
}

/** "; "-joined items with "and N more" after the first topN. */
export function listItems(t: Translate, items: readonly string[], topN: number = ASSISTANT.topN): string {
  const shown = items.slice(0, topN);
  const more = items.length - shown.length;
  const joined = shown.join(t('assistant.answer.separator'));
  return more > 0
    ? joined + t('assistant.answer.separator') + t('assistant.answer.more', { count: more })
    : joined;
}

function scopeOf(t: Translate, filters: readonly string[]): string {
  return filters.length === 0 ? '' : t('assistant.answer.scope', { filters: filters.join(', ') });
}

function unitSuffix(unit: string): string {
  return unit === '' ? '' : unit === '%' ? '%' : ' ' + unit;
}

function groupItems(
  t: Translate,
  locale: Locale,
  groups: readonly GroupCount[],
  unit: string,
  topN: number,
): string {
  return listItems(
    t,
    groups.map((g) =>
      g.value === null
        ? t('assistant.answer.groupItem', { label: g.label, count: formatNumber(locale, g.count) })
        : t('assistant.answer.groupValueItem', {
            label: g.label,
            value: formatNumber(locale, g.value) + unitSuffix(unit),
            count: formatNumber(locale, g.count),
          }),
    ),
    topN,
  );
}

function availabilityLine(t: Translate, locale: Locale, line: AvailabilityLine): string {
  // A period with no health history is not measured: no percentage, no downtime, and the target is neither met nor
  // missed.
  const target =
    line.targetPercent === null
      ? t('assistant.answer.noTarget')
      : line.met === null
        ? t('assistant.answer.targetOnly', { target: formatNumber(locale, line.targetPercent) })
        : line.met
          ? t('assistant.answer.met', { target: formatNumber(locale, line.targetPercent) })
          : t('assistant.answer.notMet', { target: formatNumber(locale, line.targetPercent) });
  if (line.availabilityPercent === null)
    return t('assistant.answer.availabilityItemUnmeasured', { service: line.name, target });
  const percent = formatNumber(locale, line.availabilityPercent) + '%';
  return t('assistant.answer.availabilityItem', {
    service: line.name,
    percent,
    down: formatNumber(locale, line.downtimeMinutes),
    target,
  });
}

/** REQ-AI-006: how one anomaly finding reads in an answer, by rule; the facts fill the template. */
const ANOMALY_ITEM = {
  ip_conflict: 'assistant.answer.anomalyItem.ip_conflict',
  unmanaged_device_in_datacenter: 'assistant.answer.anomalyItem.unmanaged_device_in_datacenter',
  flapping_service: 'assistant.answer.anomalyItem.flapping_service',
} as const satisfies Record<AnomalyRule, MessageKey>;

/** Words one skill summary, with its figures. */
export function composeSummary(
  summary: Summary,
  t: Translate,
  locale: Locale,
  topN: number = ASSISTANT.topN,
): Composed {
  switch (summary.kind) {
    case 'count': {
      const subject = typeLabel(t, summary.type);
      return {
        text: t('assistant.answer.count', {
          count: formatNumber(locale, summary.count),
          subject,
          scope: scopeOf(t, summary.filters),
        }),
        figures: [{ label: subject, value: summary.count, unit: '' }],
      };
    }
    case 'groups': {
      const subject = typeLabel(t, summary.type);
      const dimension =
        summary.dimension.kind === 'attribute'
          ? attributeLabel(t, summary.dimension.family)
          : typeLabel(t, summary.dimension.type);
      const unit = summary.unit;
      const figures: AssistantFigure[] = [
        { label: subject, value: summary.total, unit: '' },
        ...summary.groups
          .slice(0, topN)
          .map((g) => ({ label: g.label, value: g.value ?? g.count, unit: g.value === null ? '' : unit })),
      ];
      return {
        text: t('assistant.answer.groups', {
          subject,
          dimension,
          total: formatNumber(locale, summary.total),
          groups: formatNumber(locale, summary.groups.length),
          items: groupItems(t, locale, summary.groups, unit, topN),
          scope: scopeOf(t, summary.filters),
        }),
        figures,
      };
    }
    case 'aggregate': {
      const subject = typeLabel(t, summary.type);
      const attribute = attributeLabel(t, summary.family);
      return {
        text: t('assistant.answer.aggregate', {
          aggregate: aggregateLabel(t, summary.aggregate),
          attribute,
          subject,
          value: formatNumber(locale, summary.value) + unitSuffix(summary.unit),
          count: formatNumber(locale, summary.count),
          scope: scopeOf(t, summary.filters),
        }),
        figures: [
          {
            label: aggregateLabel(t, summary.aggregate) + ' ' + attribute,
            value: summary.value,
            unit: summary.unit,
          },
          { label: subject, value: summary.count, unit: '' },
        ],
      };
    }
    case 'density': {
      const subject = typeLabel(t, summary.type);
      const counterpart = typeLabel(t, summary.counterpart);
      return {
        text: t('assistant.answer.density', {
          value: formatNumber(locale, summary.avg),
          subject,
          counterpart,
          groups: formatNumber(locale, summary.groups),
          max: formatNumber(locale, summary.max),
          total: formatNumber(locale, summary.total),
          scope: scopeOf(t, summary.filters),
        }),
        figures: [
          { label: t('assistant.answer.perLabel', { subject, counterpart }), value: summary.avg, unit: '' },
          { label: counterpart, value: summary.groups, unit: '' },
          { label: subject, value: summary.total, unit: '' },
        ],
      };
    }
    case 'measurement': {
      const metric = metricLabel(t, summary.metric);
      const subject = typeLabel(t, summary.type);
      const unit = MEASUREMENTS[summary.metric].unit;
      if (summary.count === 0 || (summary.value === null && summary.ranked.length === 0))
        return { text: t('assistant.answer.measurementNone', { metric, subject }), figures: [] };
      const asOf = summary.asOf === null ? '' : formatDate(locale, summary.asOf);
      if (summary.aggregate === 'max' || summary.aggregate === 'min') {
        const items = listItems(
          t,
          summary.ranked.map((r) =>
            t('assistant.answer.rankedItem', {
              name: r.name,
              value: formatNumber(locale, r.value) + unitSuffix(unit),
            }),
          ),
          topN,
        );
        return {
          text: t(
            summary.aggregate === 'max'
              ? 'assistant.answer.measurementTop'
              : 'assistant.answer.measurementBottom',
            { metric, subject, count: formatNumber(locale, summary.count), items, asOf },
          ),
          figures: summary.ranked.slice(0, topN).map((r) => ({ label: r.name, value: r.value, unit })),
        };
      }
      const value = summary.value ?? 0;
      return {
        text: t('assistant.answer.measurement', {
          aggregate: aggregateLabel(t, summary.aggregate),
          metric,
          subject,
          count: formatNumber(locale, summary.count),
          value: formatNumber(locale, value) + unitSuffix(unit),
          asOf,
          scope: scopeOf(t, summary.filters),
        }),
        figures: [
          { label: aggregateLabel(t, summary.aggregate) + ' ' + metric, value, unit },
          { label: subject, value: summary.count, unit: '' },
        ],
      };
    }
    case 'series': {
      const metric = metricLabel(t, summary.metric);
      const subject =
        summary.ci !== null
          ? summary.ci.name
          : t('assistant.answer.seriesSubject', {
              count: formatNumber(locale, summary.count),
              subject: typeLabel(t, summary.type),
            });
      const window = windowLabel(t, locale, summary.hours, summary.to);
      if (summary.samples === 0 || summary.avg === null)
        return { text: t('assistant.answer.seriesNone', { metric, subject, window }), figures: [] };
      const unit = summary.unit;
      const trend =
        summary.trendPercent === null
          ? t('assistant.answer.trendUnknown')
          : Math.abs(summary.trendPercent) < ASSISTANT.seriesFlatPercent
            ? t('assistant.answer.trendFlat')
            : summary.trendPercent > 0
              ? t('assistant.answer.trendUp', { percent: formatNumber(locale, Math.abs(summary.trendPercent)) })
              : t('assistant.answer.trendDown', {
                  percent: formatNumber(locale, Math.abs(summary.trendPercent)),
                });
      const figures: AssistantFigure[] = [
        { label: aggregateLabel(t, 'avg') + ' ' + metric, value: summary.avg, unit },
        { label: t('assistant.answer.minLabel'), value: summary.min ?? summary.avg, unit },
        { label: t('assistant.answer.maxLabel'), value: summary.max ?? summary.avg, unit },
        { label: t('assistant.answer.latestLabel'), value: summary.last ?? summary.avg, unit },
        { label: t('assistant.answer.samplesLabel'), value: summary.samples, unit: '' },
      ];
      return {
        text: t('assistant.answer.series', {
          window,
          metric,
          subject,
          avg: formatNumber(locale, summary.avg) + unitSuffix(unit),
          min: formatNumber(locale, summary.min ?? summary.avg) + unitSuffix(unit),
          max: formatNumber(locale, summary.max ?? summary.avg) + unitSuffix(unit),
          last: formatNumber(locale, summary.last ?? summary.avg) + unitSuffix(unit),
          samples: formatNumber(locale, summary.samples),
          from: formatDate(locale, summary.from),
          to: formatDate(locale, summary.to),
          trend,
        }),
        figures,
      };
    }
    case 'availability': {
      const period = periodLabel(t, summary.granularity, summary.back);
      if (summary.lines.length === 0)
        return { text: t('assistant.answer.availabilityNone', { period }), figures: [] };
      if (summary.lines.length === 1 && summary.lines[0] !== undefined) {
        const line = summary.lines[0];
        return {
          text: t('assistant.answer.availabilityService', {
            period,
            line: availabilityLine(t, locale, line),
          }),
          figures:
            line.availabilityPercent === null
              ? []
              : [
                  { label: line.name, value: line.availabilityPercent, unit: '%' },
                  { label: t('assistant.answer.downtimeLabel'), value: line.downtimeMinutes, unit: 'min' },
                ],
        };
      }
      const worst = [...summary.lines]
        .filter((l) => l.availabilityPercent !== null)
        .sort((a, b) => (a.availabilityPercent ?? 0) - (b.availabilityPercent ?? 0))
        .slice(0, topN);
      return {
        text: t('assistant.answer.availabilityEstate', {
          period,
          services: formatNumber(locale, summary.lines.length),
          percent:
            summary.estatePercent === null
              ? t('assistant.answer.notMeasured')
              : formatNumber(locale, summary.estatePercent) + '%',
          below: formatNumber(locale, summary.belowTarget),
          down: formatNumber(locale, summary.downtimeMinutes),
          items: listItems(
            t,
            worst.map((l) => availabilityLine(t, locale, l)),
            topN,
          ),
        }),
        figures: [
          ...(summary.estatePercent === null
            ? []
            : [{ label: t('assistant.answer.estateAvailabilityLabel'), value: summary.estatePercent, unit: '%' }]),
          { label: t('assistant.answer.belowTargetLabel'), value: summary.belowTarget, unit: '' },
          { label: t('assistant.answer.downtimeLabel'), value: summary.downtimeMinutes, unit: 'min' },
          { label: typeLabel(t, 'business_service'), value: summary.lines.length, unit: '' },
        ],
      };
    }
    case 'incidents': {
      const scope =
        summary.scopeName === null ? '' : t('assistant.answer.scopeService', { service: summary.scopeName });
      if (summary.lines.length === 0)
        return {
          text: t(summary.open ? 'assistant.answer.incidentsNone' : 'assistant.answer.closedIncidentsNone', {
            scope,
          }),
          figures: [{ label: t('assistant.answer.incidentsLabel'), value: 0, unit: '' }],
        };
      const items = listItems(
        t,
        summary.lines.map((l) =>
          t('assistant.answer.incidentItem', { title: l.title, severity: l.severity, state: l.state }),
        ),
        topN,
      );
      return {
        text: t(summary.open ? 'assistant.answer.incidents' : 'assistant.answer.closedIncidents', {
          count: formatNumber(locale, summary.lines.length),
          scope,
          items,
        }),
        figures: [{ label: t('assistant.answer.incidentsLabel'), value: summary.lines.length, unit: '' }],
      };
    }
    case 'anomalies': {
      if (summary.lines.length === 0)
        return {
          text: t('assistant.answer.anomaliesNone'),
          figures: [{ label: t('assistant.answer.anomaliesLabel'), value: 0, unit: '' }],
        };
      const items = listItems(
        t,
        summary.lines.map((l) => t(ANOMALY_ITEM[l.rule], { subject: l.subject, ...l.facts })),
        topN,
      );
      return {
        text: t('assistant.answer.anomalies', { count: formatNumber(locale, summary.lines.length), items }),
        figures: [{ label: t('assistant.answer.anomaliesLabel'), value: summary.lines.length, unit: '' }],
      };
    }
    case 'impact': {
      if (summary.services.length === 0)
        return {
          text: t(
            summary.direction === 'upstream'
              ? 'assistant.answer.impactNone'
              : 'assistant.answer.dependsOnNone',
            { ci: summary.root.name },
          ),
          figures: [{ label: t('assistant.answer.nodesLabel'), value: summary.nodes, unit: '' }],
        };
      const items = listItems(
        t,
        summary.services.map((s) =>
          t('assistant.answer.impactItem', { name: s.name, predicted: s.predicted }),
        ),
        topN,
      );
      return {
        text: t(summary.direction === 'upstream' ? 'assistant.answer.impact' : 'assistant.answer.dependsOn', {
          ci: summary.root.name,
          count: formatNumber(locale, summary.services.length),
          down: formatNumber(locale, summary.down),
          degraded: formatNumber(locale, summary.degraded),
          nodes: formatNumber(locale, summary.nodes),
          items,
        }),
        figures: [
          { label: typeLabel(t, 'business_service'), value: summary.services.length, unit: '' },
          { label: t('assistant.answer.predictedDownLabel'), value: summary.down, unit: '' },
          { label: t('assistant.answer.nodesLabel'), value: summary.nodes, unit: '' },
        ],
      };
    }
    case 'history': {
      if (summary.versions === 0 || summary.latestAt === null)
        return { text: t('assistant.answer.historyNone', { ci: summary.ci.name }), figures: [] };
      return {
        text: t('assistant.answer.history', {
          ci: summary.ci.name,
          versions: formatNumber(locale, summary.versions),
          at: formatDate(locale, summary.latestAt),
          keys:
            summary.changedKeys.length === 0
              ? t('assistant.answer.noAttributeChange')
              : summary.changedKeys.join(', '),
        }),
        figures: [{ label: t('assistant.answer.versionsLabel'), value: summary.versions, unit: '' }],
      };
    }
    case 'howto':
      return { text: t(howtoKey(summary.topic)), figures: [] };
    case 'graph': {
      if (summary.rows.length === 0) return { text: t('assistant.answer.graphNone'), figures: [] };
      const first = summary.rows[0] ?? {};
      const names = summary.rows
        .map((r) => r['name'] ?? r['s.name'] ?? r['c.name'])
        .filter((v): v is string => typeof v === 'string');
      const count = formatNumber(locale, summary.rows.length);
      if (names.length > 0)
        return {
          text: t('assistant.answer.graphRows', {
            count,
            items: listItems(t, names, ASSISTANT.summaryNames),
          }),
          figures: [{ label: t('assistant.answer.rowsLabel'), value: summary.rows.length, unit: '' }],
        };
      return {
        text: t('assistant.answer.graphColumns', { count, columns: Object.keys(first).join(', ') }),
        figures: [{ label: t('assistant.answer.rowsLabel'), value: summary.rows.length, unit: '' }],
      };
    }
    case 'unresolvedFilter':
      return { text: t('assistant.answer.unresolvedFilter', { value: summary.value }), figures: [] };
  }
}

export function howtoKey(topic: HowtoTopic): MessageKey {
  const key = 'assistant.howto.' + topic;
  return isMessageKey(key) ? key : 'assistant.howto.assistant';
}

/**
 * Whether a summary says something beyond "nothing found". An empty answer is one exact sentence already, and a
 * model rewording it has nothing to add and can invert it ("X depends on nothing" for "nothing depends on X").
 */
export function hasContent(summary: Summary): boolean {
  switch (summary.kind) {
    case 'count':
      return summary.count > 0;
    case 'groups':
      return summary.groups.length > 0;
    case 'aggregate':
      return summary.count > 0;
    case 'density':
      return summary.total > 0;
    case 'measurement':
      return summary.count > 0;
    case 'series':
      return summary.samples > 0;
    case 'availability':
      return summary.lines.length > 0;
    case 'incidents':
      return summary.lines.length > 0;
    case 'anomalies':
      return summary.lines.length > 0;
    case 'impact':
      return summary.services.length > 0;
    case 'history':
      return summary.versions > 1;
    case 'graph':
      return summary.rows.length > 0;
    case 'howto':
    case 'unresolvedFilter':
      return false;
  }
}

/** Joins the wording of every summary, in plan order; failed steps are worded with their reason. */
export function composeAll(
  summaries: ReadonlyArray<{ summary: Summary | null; error: string | null }>,
  t: Translate,
  locale: Locale,
): Composed {
  const parts: string[] = [];
  const figures: AssistantFigure[] = [];
  for (const s of summaries) {
    if (s.summary !== null) {
      const c = composeSummary(s.summary, t, locale);
      parts.push(c.text);
      figures.push(...c.figures);
    } else if (s.error !== null) {
      parts.push(t('assistant.answer.failed', { reason: s.error }));
    }
  }
  return { text: parts.length === 0 ? t('assistant.answer.none') : parts.join(' '), figures };
}
