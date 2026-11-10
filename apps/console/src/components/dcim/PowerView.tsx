'use client';
// REQ-DCIM-004 (ADR-058) — the DCIM Power view for one room:
// - totals: UPS units, circuits, PDUs, devices fed and how many of them survive the loss of one feed;
// - findings: single-corded devices, devices with every cord on one feed, redundant pairs whose survivor would
//   overload, UPS units with short runtime, PDUs with more cords than outlets;
// - the chain: UPS units, the circuits they feed and the PDUs those feed, each with rating, load and feed;
// - a PDU's outlets with the device on each; operators plug a device into an outlet and unplug one;
// - monitoring, thresholds and billing (REQ-DCIM-005, PowerMonitorPanel).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CABLING, CONSOLE, POWER, ROLES } from '@openmap/constants';
import type { MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, Pill, SectionTitle, Tag, accents, cx } from '@openmap/ui';
import { useMemo, useState, type SyntheticEvent, type ReactNode } from 'react';
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
import type { Rack } from '@/lib/estate-queries';
import {
  connectPower,
  disconnectPower,
  pduConnectionsQuery,
  powerChainQuery,
  powerKey,
  type PowerFinding,
  type PowerSource,
} from '@/lib/power-queries';
import { searchQuery } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { PowerMonitorPanel } from './PowerMonitorPanel';
import { useFormatters, useT, type Translate } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const SOURCE_KINDS = ['ups', 'power_circuit', 'pdu'] as const;
/** Layers whose CIs plug into a PDU: servers and appliances (hardware), switches and firewalls (network). */
const DEVICE_LAYERS = ['hardware', 'network_security'] as const;

function findingDetail(t: Translate, kw: (w: number) => string, f: PowerFinding): string {
  if (f.kind.endsWith('failover_overload') && f.load !== null && f.capacity !== null)
    return t('dcim.power.detail.failover', {
      partner: f.partner?.name ?? '',
      load: kw(f.load),
      capacity: kw(f.capacity),
    });
  if (f.kind === 'outlets_exceeded' && f.load !== null && f.capacity !== null)
    return t('dcim.power.detail.outlets', { cords: String(f.load), outlets: String(f.capacity) });
  return t(('dcim.power.detail.' + f.kind) as MessageKey);
}

export function PowerView({ racks }: { racks: readonly Rack[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const rooms = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of racks) if (r.room !== null) byId.set(r.room.id, r.room.displayName);
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [racks]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0] ?? null;
  const chain = useQuery(powerChainQuery(room?.id ?? null));
  const [pduId, setPduId] = useState<string | null>(null);
  const outlets = useQuery(pduConnectionsQuery(pduId));
  const [text, setText] = useState('');
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);
  const hits = useQuery(
    searchQuery({ text: debounced, layers: [...DEVICE_LAYERS], first: CABLING.endpointSearchLimit }),
  );
  const [cord, setCord] = useState({ deviceId: '', outlet: '', psu: '' });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: powerKey });
  };
  const plug = useMutation({
    mutationFn: () =>
      connectPower({
        deviceId: cord.deviceId,
        pduId: pduId ?? '',
        outlet: cord.outlet === '' ? null : Number(cord.outlet),
        psu: cord.psu === '' ? null : Number(cord.psu),
      }),
    onSuccess: () => {
      setCord({ deviceId: '', outlet: '', psu: '' });
      refresh();
    },
  });
  const unplug = useMutation({ mutationFn: (id: string) => disconnectPower(id), onSuccess: refresh });
  const kw = (watts: number): string =>
    t('dcim.power.kw', { kw: format.number(watts / POWER.wattsPerKilowatt) });

  if (room === null) return <p className="text-om-sm text-om-secondary">{t('dcim.empty')}</p>;
  const failed = [plug, unplug].find((m) => m.isError);
  const pdu = chain.data?.sources.find((s) => s.ci.id === pduId) ?? null;
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    plug.mutate();
  };

  const sourceTable = (kind: (typeof SOURCE_KINDS)[number], list: readonly PowerSource[]): ReactNode => (
    <div key={kind} className="flex flex-col gap-om-6">
      <h3 className="text-om-xs font-semibold text-om-secondary">
        {t(('dcim.power.kind.' + kind) as MessageKey)}
      </h3>
      <div className="overflow-x-auto">
        <table className={tableClass} aria-label={t(('dcim.power.kind.' + kind) as MessageKey)}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>{t('dcim.power.name')}</th>
              <th className={thClass}>{t('dcim.power.feed')}</th>
              <th className={thClass}>{t('dcim.power.load')}</th>
              <th className={thClass}>{t('dcim.power.fedBy')}</th>
              {kind === 'pdu' ? <th className={thClass}>{t('dcim.power.outlets')}</th> : null}
              {kind === 'ups' ? <th className={thClass}>{t('dcim.power.runtime')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.ci.id} className={cx(rowClass, pduId === s.ci.id && 'bg-om-cyan/8')}>
                <td className={cx(tdClass, 'font-mono text-om-primary')}>{s.ci.name}</td>
                <td className={tdClass}>{s.feed ?? ''}</td>
                <td className={cx(tdClass, 'min-w-48')}>
                  {s.loadWatts === null || s.ratedWatts === null ? (
                    <span className="text-om-muted">
                      {s.loadWatts === null ? t('dcim.power.noReading') : kw(s.loadWatts)}
                    </span>
                  ) : (
                    <Bar
                      value={s.loadWatts}
                      max={s.ratedWatts}
                      accent={accents.cyan}
                      label={t('dcim.power.loadOf', { load: kw(s.loadWatts), rated: kw(s.ratedWatts) })}
                    />
                  )}
                </td>
                <td className={tdClass}>{s.fedBy.map((f) => f.name).join(', ')}</td>
                {kind === 'pdu' ? (
                  <td className={tdClass}>
                    <button
                      type="button"
                      className="font-mono text-om-primary hover:underline"
                      aria-label={t('dcim.power.showOutlets', { pdu: s.ci.name })}
                      onClick={() => {
                        setPduId(s.ci.id);
                      }}
                    >
                      {s.outlets === null
                        ? format.integer(s.outletsUsed)
                        : t('dcim.power.outletsOf', {
                            used: format.integer(s.outletsUsed),
                            total: format.integer(s.outlets),
                          })}
                    </button>
                  </td>
                ) : null}
                {kind === 'ups' ? (
                  <td className={tdClass}>
                    {s.runtimeMinutes === null
                      ? ''
                      : t('dcim.power.minutes', { minutes: format.number(s.runtimeMinutes) })}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-om-24">
      <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('dcim.power.rooms')}>
        {rooms.map((r) => (
          <Pill
            key={r.id}
            variant={room.id === r.id ? 'primary' : 'default'}
            onClick={() => {
              setRoomId(r.id);
              setPduId(null);
            }}
          >
            {r.name}
          </Pill>
        ))}
      </div>
      {chain.isPending ? (
        <QueryState status="pending" />
      ) : chain.isError ? (
        <QueryState status="error" onRetry={() => void chain.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
            <Kpi label={t('dcim.power.kpi.ups')} value={format.integer(chain.data.summary.ups)} />
            <Kpi label={t('dcim.power.kpi.circuits')} value={format.integer(chain.data.summary.circuits)} />
            <Kpi label={t('dcim.power.kpi.pdus')} value={format.integer(chain.data.summary.pdus)} />
            <Kpi label={t('dcim.power.kpi.devices')} value={format.integer(chain.data.summary.devices)} />
            <Kpi
              label={t('dcim.power.kpi.redundant')}
              value={format.integer(chain.data.summary.redundantDevices)}
              unit={t('dcim.power.kpi.of', { total: format.integer(chain.data.summary.devices) })}
            />
          </div>

          <Card padding="24" className="flex flex-col gap-om-12">
            <SectionTitle as="h2" size="sm" description={t('dcim.power.findings.subtitle')}>
              {t('dcim.power.findings.title')}
            </SectionTitle>
            {chain.data.findings.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('dcim.power.findings.none')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('dcim.power.findings.title')}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>{t('dcim.power.finding')}</th>
                      <th className={thClass}>{t('dcim.power.name')}</th>
                      <th className={thClass}>{t('dcim.power.detail.title')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.data.findings.map((f) => (
                      <tr key={f.kind + f.ci.id} className={rowClass}>
                        <td className={tdClass}>
                          <Tag
                            variant="state"
                            state={f.kind.endsWith('failover_overload') ? 'down' : 'at_risk'}
                          >
                            {t(('dcim.power.findingKind.' + f.kind) as MessageKey)}
                          </Tag>
                        </td>
                        <td className={cx(tdClass, 'font-mono text-om-primary')}>{f.ci.name}</td>
                        <td className={tdClass}>{findingDetail(t, kw, f)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padding="24" className="flex flex-col gap-om-16">
            <SectionTitle as="h2" size="sm" description={t('dcim.power.chain.subtitle')}>
              {t('dcim.power.chain.title')}
            </SectionTitle>
            {SOURCE_KINDS.map((k) =>
              sourceTable(
                k,
                chain.data.sources.filter((s) => s.kind === k),
              ),
            )}
          </Card>

          <PowerMonitorPanel roomId={room.id} />

          {pdu !== null ? (
            <Card padding="24" className="flex flex-col gap-om-12">
              <SectionTitle as="h2" size="sm" description={t('dcim.power.outletsSubtitle')}>
                {t('dcim.power.outletsTitle', { pdu: pdu.ci.name })}
              </SectionTitle>
              {outlets.isPending ? (
                <QueryState status="pending" />
              ) : outlets.isError ? (
                <QueryState status="error" onRetry={() => void outlets.refetch()} />
              ) : (
                <div className="overflow-x-auto">
                  <table
                    className={tableClass}
                    aria-label={t('dcim.power.outletsTitle', { pdu: pdu.ci.name })}
                  >
                    <thead className={theadClass}>
                      <tr>
                        <th className={thClass}>{t('dcim.power.outlet')}</th>
                        <th className={thClass}>{t('dcim.power.device')}</th>
                        <th className={thClass}>{t('dcim.power.psu')}</th>
                        <th className={thClass}>{t('dcim.power.feed')}</th>
                        {can(ROLES.operator) ? (
                          <th className={thClass}>{t('dcim.cabling.actions')}</th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {outlets.data.map((c) => (
                        <tr key={c.id} className={rowClass}>
                          <td className={tdClass}>{c.outlet ?? t('dcim.power.unknownOutlet')}</td>
                          <td className={cx(tdClass, 'font-mono text-om-primary')}>{c.device.name}</td>
                          <td className={tdClass}>{c.psu ?? ''}</td>
                          <td className={tdClass}>{c.feed ?? ''}</td>
                          {can(ROLES.operator) ? (
                            <td className={tdClass}>
                              <Button
                                tone="danger"
                                disabled={unplug.isPending}
                                aria-label={t('dcim.power.unplugDevice', { device: c.device.name })}
                                onClick={() => { unplug.mutate(c.id); }}
                              >
                                {t('dcim.power.unplug')}
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {can(ROLES.operator) ? (
                <form
                  aria-label={t('dcim.power.plug')}
                  onSubmit={submit}
                  className="flex flex-wrap items-end gap-om-10"
                >
                  <label className={labelClass}>
                    {t('dcim.power.findDevice')}
                    <TextInput type="search" value={text} onChange={(e) => { setText(e.target.value); }} />
                  </label>
                  <label className={labelClass}>
                    {t('dcim.power.device')}
                    <Select
                      required
                      value={cord.deviceId}
                      onChange={(e) => { setCord({ ...cord, deviceId: e.target.value }); }}
                    >
                      <option value="">{t('dcim.cabling.endpoint.choose')}</option>
                      {(hits.data ?? []).map((h) => (
                        <option key={h.ci.id} value={h.ci.id}>
                          {t('dcim.cabling.endpoint.option', { name: h.ci.name, type: h.ci.type })}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className={labelClass}>
                    {t('dcim.power.outlet')}
                    <TextInput
                      type="number"
                      min={1}
                      value={cord.outlet}
                      onChange={(e) => { setCord({ ...cord, outlet: e.target.value }); }}
                      className="w-20"
                    />
                  </label>
                  <label className={labelClass}>
                    {t('dcim.power.psu')}
                    <TextInput
                      type="number"
                      min={1}
                      value={cord.psu}
                      onChange={(e) => { setCord({ ...cord, psu: e.target.value }); }}
                      className="w-20"
                    />
                  </label>
                  <Button type="submit" disabled={plug.isPending}>
                    {t('dcim.power.plug')}
                  </Button>
                </form>
              ) : null}
              {failed !== undefined ? (
                <p role="alert" className="text-om-xs text-om-state-down">
                  {failed.error.message}
                </p>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
