'use client';
// REQ-DCIM-006 (ADR-060) — the DCIM Environment view for one room over a window:
// - racks inside the recommended range, over it, outside the allowable range and unread; the hottest inlet; the room's
//   humidity and its state;
// - each rack's inlet trend, latest inlet and outlet, the rise across it, and its temperature and airflow states;
// - each cooling unit's supply and return air, humidity and capacity in use.
// The envelope is ASHRAE A1 (ENVIRONMENT); a reading older than ENVIRONMENT.freshMs is shown but not judged.
import { useQuery } from '@tanstack/react-query';
import { ENVIRONMENT, UTILISATION } from '@openmap/constants';
import type { EnvState } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, Pill, SectionTitle, Sparkline, Tag, accents, cx } from '@openmap/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { Select, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { roomEnvironmentQuery } from '@/lib/environment-queries';
import type { Rack } from '@/lib/estate-queries';
import { useFormatters, useT } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const TAG = {
  normal: 'healthy',
  warning: 'at_risk',
  critical: 'down',
  unknown: 'unknown',
} as const satisfies Record<EnvState, 'healthy' | 'at_risk' | 'down' | 'unknown'>;

function StateTag({
  state,
  kind,
}: {
  state: EnvState;
  kind: 'temperature' | 'airflow' | 'humidity';
}): ReactNode {
  const t = useT();
  return (
    <Tag variant="state" state={TAG[state]}>
      {t(('dcim.env.state.' + kind + '.' + state) as MessageKey)}
    </Tag>
  );
}

export function EnvironmentView({ racks }: { racks: readonly Rack[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const rooms = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of racks) if (r.room !== null) byId.set(r.room.id, r.room.displayName);
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [racks]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [hours, setHours] = useState<number>(UTILISATION.windowsHours[0]);
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0] ?? null;
  const env = useQuery(roomEnvironmentQuery(room?.id ?? null, hours));
  const c = (v: number | null): string => (v === null ? '' : t('dcim.env.celsius', { c: format.number(v) }));
  const pct = (v: number | null): string =>
    v === null ? '' : t('dcim.env.percent', { value: format.number(v) });

  if (room === null) return <p className="text-om-sm text-om-secondary">{t('dcim.empty')}</p>;
  return (
    <div className="flex flex-col gap-om-24">
      <div className="flex flex-wrap items-end justify-between gap-om-12">
        <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('dcim.env.rooms')}>
          {rooms.map((r) => (
            <Pill
              key={r.id}
              variant={room.id === r.id ? 'primary' : 'default'}
              onClick={() => setRoomId(r.id)}
            >
              {r.name}
            </Pill>
          ))}
        </div>
        <label className={labelClass}>
          {t('dcim.monitor.window')}
          <Select value={String(hours)} onChange={(e) => setHours(Number(e.target.value))}>
            {UTILISATION.windowsHours.map((h) => (
              <option key={h} value={h}>
                {t(('dcim.monitor.windows.' + String(h)) as MessageKey)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {env.isPending ? (
        <QueryState status="pending" />
      ) : env.isError ? (
        <QueryState status="error" onRetry={() => void env.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
            <Kpi
              label={t('dcim.env.kpi.normal')}
              value={format.integer(env.data.summary.normal)}
              unit={t('dcim.power.kpi.of', { total: format.integer(env.data.summary.racks) })}
            />
            <Kpi label={t('dcim.env.kpi.warning')} value={format.integer(env.data.summary.warning)} />
            <Kpi label={t('dcim.env.kpi.critical')} value={format.integer(env.data.summary.critical)} />
            <Kpi
              label={t('dcim.env.kpi.hottest')}
              value={
                env.data.summary.hottestInletC === null ? '' : format.number(env.data.summary.hottestInletC)
              }
              unit={t('dcim.env.celsiusUnit')}
            />
            <Kpi
              label={t('dcim.env.kpi.humidity')}
              value={env.data.humidityRh === null ? '' : format.number(env.data.humidityRh)}
              unit={t('dcim.env.percentUnit')}
            />
          </div>
          <Card padding="24" className="flex flex-col gap-om-12">
            <SectionTitle
              as="h2"
              size="sm"
              description={t('dcim.env.racks.subtitle', {
                min: String(ENVIRONMENT.recommendedC.min),
                max: String(ENVIRONMENT.recommendedC.max),
                amin: String(ENVIRONMENT.allowableC.min),
                amax: String(ENVIRONMENT.allowableC.max),
                rise: String(ENVIRONMENT.maxRackRiseC),
              })}
              action={<StateTag state={env.data.humidityState} kind="humidity" />}
            >
              {t('dcim.env.racks.title')}
            </SectionTitle>
            <div className="overflow-x-auto">
              <table className={tableClass} aria-label={t('dcim.env.racks.title')}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>{t('dcim.env.rack')}</th>
                    <th className={thClass}>{t('dcim.env.trend')}</th>
                    <th className={thClass}>{t('dcim.env.inlet')}</th>
                    <th className={thClass}>{t('dcim.env.outlet')}</th>
                    <th className={thClass}>{t('dcim.env.rise')}</th>
                    <th className={thClass}>{t('dcim.env.temperature')}</th>
                    <th className={thClass}>{t('dcim.env.airflow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {env.data.racks.map((r) => (
                    <tr key={r.rack.id} className={rowClass}>
                      <td className={cx(tdClass, 'font-mono text-om-primary')}>{r.rack.name}</td>
                      <td className={cx(tdClass, 'w-36')}>
                        {r.inletSeries.length === 0 ? null : (
                          <Sparkline
                            values={r.inletSeries.map((p) => p.value)}
                            accent={accents.amber}
                            label={t('dcim.env.trendOf', { rack: r.rack.name })}
                          />
                        )}
                      </td>
                      <td className={tdClass}>{c(r.inletC)}</td>
                      <td className={tdClass}>{c(r.outletC)}</td>
                      <td className={tdClass}>{c(r.riseC)}</td>
                      <td className={tdClass}>
                        <StateTag state={r.temperatureState} kind="temperature" />
                      </td>
                      <td className={tdClass}>
                        <StateTag state={r.airflowState} kind="airflow" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card padding="24" className="flex flex-col gap-om-12">
            <SectionTitle as="h2" size="sm" description={t('dcim.env.cooling.subtitle')}>
              {t('dcim.env.cooling.title')}
            </SectionTitle>
            {env.data.coolingUnits.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('dcim.env.cooling.none')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('dcim.env.cooling.title')}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>{t('dcim.env.unit')}</th>
                      <th className={thClass}>{t('dcim.env.supply')}</th>
                      <th className={thClass}>{t('dcim.env.return')}</th>
                      <th className={thClass}>{t('dcim.env.humidity')}</th>
                      <th className={thClass}>{t('dcim.env.capacity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {env.data.coolingUnits.map((u) => (
                      <tr key={u.unit.id} className={rowClass}>
                        <td className={cx(tdClass, 'font-mono text-om-primary')}>{u.unit.name}</td>
                        <td className={tdClass}>{c(u.supplyC)}</td>
                        <td className={tdClass}>{c(u.returnC)}</td>
                        <td className={tdClass}>
                          {pct(u.humidityRh)} <StateTag state={u.state} kind="humidity" />
                        </td>
                        <td className={tdClass}>{pct(u.capacityPercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
