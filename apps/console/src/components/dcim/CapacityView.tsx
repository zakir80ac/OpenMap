'use client';
// REQ-DCIM-007 (ADR-061) — the DCIM Capacity view for one room:
// - four figures: rack units used, power drawn against design, cooling load against rated capacity, ports live against
//   total, each judged against the warning and critical lines;
// - the power trend over the last days with the days left to each line, or why there is no forecast;
// - "what fits": a device height, draw and port count, and how many such devices the room still takes, packed into
//   each rack's free blocks and bounded by its power and port headroom;
// - the racks, worst state first, with free units, largest free block, power, ports and the fit count.
import { useQuery } from '@tanstack/react-query';
import { CAPACITY } from '@openmap/constants';
import { fitsInRack, type CapacityState, type DeviceSpec } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Field,
  Select,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { roomCapacityQuery, type RackCapacity, type RoomCapacity } from '@/lib/capacity-queries';
import type { Rack } from '@/lib/estate-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT, type Translate } from '@/providers';

/** Worst first: the states to act on head the table. */
const STATE_ORDER: readonly CapacityState[] = ['critical', 'warning', 'normal', 'unknown'];

export function stateKey(state: CapacityState): MessageKey {
  return `dcim.capacity.state.${state}`;
}

/** Racks worst state first, then by name, so the ones to act on head the table. */
export function sortRacks(racks: readonly RackCapacity[]): RackCapacity[] {
  return [...racks].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      a.rack.displayName.localeCompare(b.rack.displayName),
  );
}

/** How many devices of the spec each rack takes, and the room total with the number of racks that take at least one. */
export function fitSummary(
  racks: readonly RackCapacity[],
  spec: DeviceSpec,
): { perRack: Map<string, number>; devices: number; racks: number } {
  const perRack = new Map<string, number>();
  let devices = 0;
  let withRoom = 0;
  for (const r of racks) {
    const blocks = r.space.freeBlocks.map((height) => ({ start: 0, height }));
    // A rack with no design power or no counted ports is not constrained by that dimension: nothing is known to run out.
    const freeWatts =
      r.power.designWatts > 0
        ? Math.max(0, r.power.designWatts - r.power.loadWatts)
        : Number.POSITIVE_INFINITY;
    const freePorts = r.ports.total > 0 ? r.ports.free : Number.POSITIVE_INFINITY;
    const fit = fitsInRack(
      blocks,
      { largestFreeBlock: r.space.largestFreeBlock, freeUnits: r.space.free, freeWatts, freePorts },
      spec,
    );
    perRack.set(r.rack.id, fit);
    devices += fit;
    if (fit > 0) withRoom += 1;
  }
  return { perRack, devices, racks: withRoom };
}

function percentText(t: Translate, format: ReturnType<typeof useFormatters>, percent: number | null): string {
  return percent === null
    ? t('dcim.capacity.notMeasured')
    : t('dcim.capacity.percent', { percent: format.integer(Math.round(percent)) });
}

function StateTag({ state }: { state: CapacityState }): ReactNode {
  const t = useT();
  return (
    <span data-state={state}>
      <Tag>{t(stateKey(state))}</Tag>
    </span>
  );
}

function clampNumber(raw: string, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

export function CapacityView({ locale, racks }: { locale: Locale; racks: readonly Rack[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const rooms = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of racks) if (r.room !== null) byId.set(r.room.id, r.room.displayName);
    return [...byId.entries()]
      .map(([roomId, name]) => ({ id: roomId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [racks]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0] ?? null;
  const capacity = useQuery(roomCapacityQuery(room?.id ?? null));
  const [spec, setSpec] = useState<DeviceSpec>({ ...CAPACITY.defaultSpec });
  const [showAll, setShowAll] = useState(false);

  const data: RoomCapacity | undefined = capacity.data;
  const sorted = useMemo(() => (data === undefined ? [] : sortRacks(data.racks)), [data]);
  const fit = useMemo(() => fitSummary(sorted, spec), [sorted, spec]);
  const shown = showAll ? sorted : sorted.slice(0, CAPACITY.rackRows);

  if (room === null) return <p className="text-om-sm text-om-secondary">{t('dcim.empty')}</p>;

  return (
    <div className="flex flex-col gap-om-16" data-testid="dcim-capacity">
      <div className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-room'} label={t('dcim.capacity.room')}>
          <Select
            id={id + '-room'}
            value={room.id}
            onChange={(event) => {
              setRoomId(event.target.value);
              setShowAll(false);
            }}
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {data !== undefined ? <StateTag state={data.state} /> : null}
      </div>

      {capacity.isPending ? <QueryState status="pending" /> : null}
      {capacity.isError ? <QueryState status="error" /> : null}
      {data !== undefined ? (
        <>
          <div
            className="grid grid-cols-2 gap-om-12 md:grid-cols-4"
            role="group"
            aria-label={t('dcim.capacity.figures')}
          >
            <Kpi
              label={t('dcim.capacity.space')}
              value={percentText(t, format, data.space.percent)}
              unit={
                <StateTag
                  state={
                    data.space.percent === null
                      ? 'unknown'
                      : data.space.percent >= CAPACITY.criticalPercent
                        ? 'critical'
                        : data.space.percent >= CAPACITY.warnPercent
                          ? 'warning'
                          : 'normal'
                  }
                />
              }
            />
            <Kpi
              label={t('dcim.capacity.power')}
              value={percentText(t, format, data.power.percent)}
              unit={<StateTag state={data.power.state} />}
            />
            <Kpi
              label={t('dcim.capacity.cooling')}
              value={percentText(t, format, data.cooling.percent)}
              unit={<StateTag state={data.cooling.state} />}
            />
            <Kpi
              label={t('dcim.capacity.ports')}
              value={percentText(t, format, data.ports.percent)}
              unit={
                <StateTag
                  state={
                    data.ports.percent === null
                      ? 'unknown'
                      : data.ports.percent >= CAPACITY.criticalPercent
                        ? 'critical'
                        : data.ports.percent >= CAPACITY.warnPercent
                          ? 'warning'
                          : 'normal'
                  }
                />
              }
            />
          </div>
          <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
            <Card padding="16" className="flex flex-col gap-om-6">
              <SectionTitle as="h2" size="sm">
                {t('dcim.capacity.totals')}
              </SectionTitle>
              <ul className="flex flex-col gap-om-4 text-om-sm text-om-secondary">
                <li>
                  {t('dcim.capacity.unitsFree', {
                    free: format.integer(data.space.free),
                    units: format.integer(data.space.units),
                    block: format.integer(data.space.largestFreeBlock),
                  })}
                </li>
                <li>
                  {t('dcim.capacity.wattsUsed', {
                    load: format.integer(Math.round(data.power.loadWatts)),
                    design: format.integer(data.power.designWatts),
                  })}
                </li>
                <li>
                  {t('dcim.capacity.coolingUsed', {
                    load: format.integer(Math.round(data.cooling.loadKw)),
                    capacity: format.integer(Math.round(data.cooling.capacityKw)),
                    units: format.integer(data.cooling.units),
                  })}
                </li>
                <li>
                  {t('dcim.capacity.portsUsed', {
                    used: format.integer(data.ports.used),
                    total: format.integer(data.ports.total),
                  })}
                </li>
              </ul>
            </Card>
            <Card padding="16" className="flex flex-col gap-om-6">
              <div className="flex flex-col gap-om-6" data-testid="dcim-capacity-trend">
                <SectionTitle as="h2" size="sm">
                  {t('dcim.capacity.trend.title', { days: format.integer(data.trend.days) })}
                </SectionTitle>
                {data.trend.slopeKwPerDay === null ? (
                  <p className="text-om-sm text-om-secondary">
                    {t('dcim.capacity.trend.insufficient', {
                      min: format.integer(CAPACITY.trendMinPoints),
                      points: format.integer(data.trend.points),
                    })}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-om-4 text-om-sm text-om-secondary">
                    <li>
                      {t('dcim.capacity.trend.slope', {
                        slope: data.trend.slopeKwPerDay.toFixed(CAPACITY.trendDecimals),
                      })}
                    </li>
                    <li>
                      {data.trend.daysToWarning === null
                        ? t('dcim.capacity.trend.flat')
                        : t('dcim.capacity.trend.toWarning', {
                            days: format.integer(data.trend.daysToWarning),
                          })}
                    </li>
                    {data.trend.daysToCritical !== null ? (
                      <li>
                        {t('dcim.capacity.trend.toCritical', {
                          days: format.integer(data.trend.daysToCritical),
                        })}
                      </li>
                    ) : null}
                  </ul>
                )}
              </div>
            </Card>
          </div>

          <Card padding="16" className="flex flex-col gap-om-10">
            <SectionTitle as="h2" size="sm" description={t('dcim.capacity.fit.subtitle')}>
              {t('dcim.capacity.fit.title')}
            </SectionTitle>
            <form
              className="flex flex-wrap items-end gap-om-10"
              data-testid="dcim-capacity-fit"
              aria-label={t('dcim.capacity.fit.title')}
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <Field id={id + '-height'} label={t('dcim.capacity.fit.heightU')}>
                <TextInput
                  id={id + '-height'}
                  type="number"
                  min={1}
                  max={CAPACITY.maxSpecHeightU}
                  value={spec.heightU}
                  onChange={(e) => {
                    setSpec({
                      ...spec,
                      heightU: Math.max(1, clampNumber(e.target.value, CAPACITY.maxSpecHeightU)),
                    });
                  }}
                />
              </Field>
              <Field id={id + '-watts'} label={t('dcim.capacity.fit.watts')}>
                <TextInput
                  id={id + '-watts'}
                  type="number"
                  min={0}
                  max={CAPACITY.maxSpecWatts}
                  value={spec.watts}
                  onChange={(e) => {
                    setSpec({ ...spec, watts: clampNumber(e.target.value, CAPACITY.maxSpecWatts) });
                  }}
                />
              </Field>
              <Field id={id + '-ports'} label={t('dcim.capacity.fit.ports')}>
                <TextInput
                  id={id + '-ports'}
                  type="number"
                  min={0}
                  max={CAPACITY.maxSpecPorts}
                  value={spec.ports}
                  onChange={(e) => {
                    setSpec({ ...spec, ports: clampNumber(e.target.value, CAPACITY.maxSpecPorts) });
                  }}
                />
              </Field>
              <p className="text-om-sm text-om-primary" role="status">
                {t('dcim.capacity.fit.result', {
                  devices: format.integer(fit.devices),
                  racks: format.integer(fit.racks),
                  total: format.integer(sorted.length),
                })}
              </p>
            </form>
          </Card>

          <Card padding="16" className="flex flex-col gap-om-10">
            <SectionTitle as="h2" size="sm">
              {t('dcim.capacity.table.title', { count: format.integer(sorted.length) })}
            </SectionTitle>
            <div className="overflow-x-auto">
              <table className={tableClass} data-testid="dcim-capacity-table">
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.rack')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.freeUnits')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.largestBlock')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.power')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.ports')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.fits')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('dcim.capacity.table.state')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.rack.id} className={rowClass}>
                      <td className={tdClass}>
                        <Link
                          href={localizedHref(locale, '/cmdb/' + encodeURIComponent(r.rack.id))}
                          className="text-om-primary hover:text-om-cyan"
                        >
                          {r.rack.displayName}
                        </Link>
                      </td>
                      <td className={tdClass + ' font-om-mono'}>
                        {t('dcim.capacity.table.unitsCell', {
                          free: format.integer(r.space.free),
                          units: format.integer(r.space.units),
                        })}
                      </td>
                      <td className={tdClass + ' font-om-mono'}>
                        {format.integer(r.space.largestFreeBlock)}
                      </td>
                      <td className={tdClass + ' font-om-mono'}>
                        {r.power.percent === null
                          ? t('dcim.capacity.notMeasured')
                          : t('dcim.capacity.table.powerCell', {
                              load: format.integer(Math.round(r.power.loadWatts)),
                              design: format.integer(r.power.designWatts),
                              percent: format.integer(Math.round(r.power.percent)),
                            })}
                      </td>
                      <td className={tdClass + ' font-om-mono'}>
                        {t('dcim.capacity.table.portsCell', {
                          free: format.integer(r.ports.free),
                          total: format.integer(r.ports.total),
                        })}
                      </td>
                      <td className={tdClass + ' font-om-mono'}>
                        {format.integer(fit.perRack.get(r.rack.id) ?? 0)}
                      </td>
                      <td className={tdClass}>
                        <StateTag state={r.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sorted.length > shown.length ? (
              <div>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setShowAll(true);
                  }}
                >
                  {t('dcim.capacity.showAll', { count: format.integer(sorted.length) })}
                </Button>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
