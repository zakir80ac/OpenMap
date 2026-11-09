'use client';
// REQ-DCIM-005 (ADR-059) — power monitoring for one room on the DCIM Power view:
// - a window (a day, a week, a month) and the room's totals: energy delivered and, with a tariff, its cost;
// - each PDU's measured draw as a sparkline, its latest reading against its rating, its state against the tenant's
//   lines, its peak and the energy between its samples (how many hours they span);
// - energy billed back by device (the outlets its cords are on) with its owning cost centre;
// - the tenant's warning and critical lines and its tariff, set by administrators.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BSM, POWER, ROLES, UTILISATION } from '@openmap/constants';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Sparkline, Tag, accents, cx } from '@openmap/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Button,
  Select,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import {
  powerKey,
  powerMonitorQuery,
  updatePowerSettings,
  type PowerSettings,
  type PowerState,
} from '@/lib/power-queries';
import { useFormatters, useT } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const STATE_TAG = {
  normal: 'healthy',
  warning: 'at_risk',
  critical: 'down',
  unknown: 'unknown',
} as const satisfies Record<PowerState, 'healthy' | 'at_risk' | 'down' | 'unknown'>;

function SettingsForm({ settings }: { settings: PowerSettings }): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    warnPercent: String(settings.warnPercent),
    criticalPercent: String(settings.criticalPercent),
    tariffPerKwh: settings.tariffPerKwh === null ? '' : String(settings.tariffPerKwh),
    currency: settings.currency ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      updatePowerSettings({
        warnPercent: Number(form.warnPercent),
        criticalPercent: Number(form.criticalPercent),
        tariffPerKwh: form.tariffPerKwh.trim() === '' ? null : Number(form.tariffPerKwh),
        currency: form.currency.trim() === '' ? null : form.currency.trim().toUpperCase(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: powerKey });
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form
      aria-label={t('dcim.monitor.settings')}
      onSubmit={submit}
      className="flex flex-wrap items-end gap-om-10"
    >
      <label className={labelClass}>
        {t('dcim.monitor.warnPercent')}
        <TextInput
          required
          type="number"
          min={1}
          max={BSM.percentScale}
          value={form.warnPercent}
          onChange={(e) => setForm({ ...form, warnPercent: e.target.value })}
          className="w-24"
        />
      </label>
      <label className={labelClass}>
        {t('dcim.monitor.criticalPercent')}
        <TextInput
          required
          type="number"
          min={1}
          max={BSM.percentScale}
          value={form.criticalPercent}
          onChange={(e) => setForm({ ...form, criticalPercent: e.target.value })}
          className="w-24"
        />
      </label>
      <label className={labelClass}>
        {t('dcim.monitor.tariff')}
        <TextInput
          type="number"
          min={0}
          step="any"
          value={form.tariffPerKwh}
          onChange={(e) => setForm({ ...form, tariffPerKwh: e.target.value })}
          className="w-28"
        />
      </label>
      <label className={labelClass}>
        {t('dcim.monitor.currency')}
        <TextInput
          value={form.currency}
          onChange={(e) => setForm({ ...form, currency: e.target.value })}
          className="w-20"
        />
      </label>
      <Button type="submit" disabled={save.isPending}>
        {t('dcim.monitor.saveSettings')}
      </Button>
      {save.isError ? (
        <p role="alert" className="text-om-xs text-om-state-down">
          {save.error.message}
        </p>
      ) : null}
    </form>
  );
}

export function PowerMonitorPanel({ roomId }: { roomId: string }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const [hours, setHours] = useState<number>(UTILISATION.windowsHours[0]);
  const monitor = useQuery(powerMonitorQuery(roomId, hours));
  const kw = (watts: number): string =>
    t('dcim.power.kw', { kw: format.number(watts / POWER.wattsPerKilowatt) });
  const kwh = (v: number): string => t('dcim.monitor.kwh', { kwh: format.number(v) });
  const money = (v: number | null, currency: string | null): string =>
    v === null || currency === null ? '' : t('dcim.monitor.money', { amount: format.number(v), currency });

  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('dcim.monitor.subtitle')}
        action={
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
        }
      >
        {t('dcim.monitor.title')}
      </SectionTitle>
      {monitor.isPending ? (
        <QueryState status="pending" />
      ) : monitor.isError ? (
        <QueryState status="error" onRetry={() => void monitor.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
            <Kpi
              label={t('dcim.monitor.kpi.energy')}
              value={format.number(monitor.data.totalKwh)}
              unit={t('dcim.monitor.kwhUnit')}
            />
            <Kpi
              label={t('dcim.monitor.kpi.cost')}
              value={
                monitor.data.totalCost === null
                  ? t('dcim.monitor.noTariff')
                  : format.number(monitor.data.totalCost)
              }
              unit={monitor.data.settings.currency ?? undefined}
            />
            <Kpi
              label={t('dcim.monitor.kpi.critical')}
              value={format.integer(monitor.data.pdus.filter((p) => p.state === 'critical').length)}
            />
            <Kpi
              label={t('dcim.monitor.kpi.warning')}
              value={format.integer(monitor.data.pdus.filter((p) => p.state === 'warning').length)}
            />
          </div>
          <div className="overflow-x-auto">
            <table className={tableClass} aria-label={t('dcim.monitor.pdus')}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>{t('dcim.power.name')}</th>
                  <th className={thClass}>{t('dcim.monitor.draw')}</th>
                  <th className={thClass}>{t('dcim.monitor.latest')}</th>
                  <th className={thClass}>{t('dcim.monitor.state')}</th>
                  <th className={thClass}>{t('dcim.monitor.peak')}</th>
                  <th className={thClass}>{t('dcim.monitor.energy')}</th>
                  <th className={thClass}>{t('dcim.monitor.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {monitor.data.pdus.map((p) => (
                  <tr key={p.pdu.id} className={rowClass}>
                    <td className={cx(tdClass, 'font-mono text-om-primary')}>{p.pdu.name}</td>
                    <td className={cx(tdClass, 'w-40')}>
                      {p.series.length === 0 ? (
                        <span className="text-om-muted">{t('dcim.power.noReading')}</span>
                      ) : (
                        <Sparkline
                          values={p.series.map((s) => s.watts)}
                          accent={accents.blue}
                          label={t('dcim.monitor.drawOf', { pdu: p.pdu.name })}
                        />
                      )}
                    </td>
                    <td className={tdClass}>
                      {p.latestWatts === null
                        ? ''
                        : p.ratedWatts === null
                          ? kw(p.latestWatts)
                          : t('dcim.power.loadOf', { load: kw(p.latestWatts), rated: kw(p.ratedWatts) })}
                    </td>
                    <td className={tdClass}>
                      <Tag variant="state" state={STATE_TAG[p.state]}>
                        {t(('dcim.monitor.states.' + p.state) as MessageKey)}
                      </Tag>
                    </td>
                    <td className={tdClass}>{p.peakWatts === null ? '' : kw(p.peakWatts)}</td>
                    <td className={tdClass}>
                      {kwh(p.energyKwh)}
                      <span className="ms-om-6 text-om-muted">
                        {t('dcim.monitor.covered', { hours: format.number(p.coveredHours) })}
                      </span>
                    </td>
                    <td className={tdClass}>{money(p.cost, monitor.data.settings.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SectionTitle as="h3" size="sm" description={t('dcim.monitor.billing.subtitle')}>
            {t('dcim.monitor.billing.title')}
          </SectionTitle>
          {monitor.data.devices.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('dcim.monitor.billing.none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass} aria-label={t('dcim.monitor.billing.title')}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>{t('dcim.power.device')}</th>
                    <th className={thClass}>{t('dcim.monitor.costCentre')}</th>
                    <th className={thClass}>{t('dcim.power.outlets')}</th>
                    <th className={thClass}>{t('dcim.monitor.energy')}</th>
                    <th className={thClass}>{t('dcim.monitor.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {monitor.data.devices.map((d) => (
                    <tr key={d.device.id} className={rowClass}>
                      <td className={cx(tdClass, 'font-mono text-om-primary')}>{d.device.name}</td>
                      <td className={tdClass}>{d.costCentre?.name ?? t('dcim.monitor.noOwner')}</td>
                      <td className={tdClass}>{format.integer(d.outlets)}</td>
                      <td className={tdClass}>{kwh(d.energyKwh)}</td>
                      <td className={tdClass}>{money(d.cost, monitor.data.settings.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can(ROLES.admin) ? (
            <SettingsForm key={JSON.stringify(monitor.data.settings)} settings={monitor.data.settings} />
          ) : null}
        </>
      )}
    </Card>
  );
}
