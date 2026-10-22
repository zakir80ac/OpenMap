'use client';
// REQ-UI-011 REQ-DCIM-001 — DCIM: rooms with a heat map of their racks (power draw against rating, occupancy), the
// selected rack's elevation drawn as an isometric SVG from the located_in positions the collectors report, its
// devices and the PDUs or feeds powering it. Every figure comes from `racks`; nothing is drawn that was not observed.
import { useQuery } from '@tanstack/react-query';
import { BSM, DCIM, POWER } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, Pill, SectionTitle, Tag, accents, cx, layerColor, text, type HexColor } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { racksQuery, type Rack } from '@/lib/estate-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

export interface DcimViewProps {
  locale: Locale;
}

export interface RoomGroup {
  id: string;
  name: string;
  designKw: number | null;
  racks: Rack[];
  ratedWatts: number;
  currentWatts: number;
  units: number;
  occupiedUnits: number;
}

export function rackPower(rack: Rack): { ratedWatts: number; currentWatts: number } {
  return rack.powerFeeds.reduce((acc, f) => ({ ratedWatts: acc.ratedWatts + f.ratedWatts, currentWatts: acc.currentWatts + f.currentWatts }), { ratedWatts: 0, currentWatts: 0 });
}

export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(BSM.percentScale, (part / whole) * BSM.percentScale);
}

/** Racks grouped by room (racks without a room share one unplaced group), rooms sorted by name. */
export function groupRooms(racks: ReadonlyArray<Rack>, unplacedLabel: string): RoomGroup[] {
  const map = new Map<string, RoomGroup>();
  for (const rack of racks) {
    const key = rack.room?.id ?? '';
    const group = map.get(key) ?? { id: key, name: rack.room?.displayName ?? unplacedLabel, designKw: typeof rack.room?.attributes['designKw'] === 'number' ? (rack.room.attributes['designKw'] as number) : null, racks: [], ratedWatts: 0, currentWatts: 0, units: 0, occupiedUnits: 0 };
    const power = rackPower(rack);
    group.racks.push(rack);
    group.ratedWatts += power.ratedWatts;
    group.currentWatts += power.currentWatts;
    group.units += rack.units;
    group.occupiedUnits += rack.occupiedUnits;
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ ...g, racks: [...g.racks].sort((a, b) => a.ci.name.localeCompare(b.ci.name)) }));
}

/** Heat colour from power utilisation thresholds; occupancy only when no power is reported. */
export function heatAccent(powerPercent: number, occupancyPercent: number): HexColor {
  const value = powerPercent > 0 ? powerPercent : occupancyPercent;
  if (value >= DCIM.criticalPowerPercent) return accents.rose;
  if (value >= DCIM.warnPowerPercent) return accents.amber;
  return accents.emerald;
}

export function DcimView({ locale }: DcimViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const racks = useQuery(racksQuery());
  const [roomId, setRoomId] = useState<string | null>(null);
  const [rackId, setRackId] = useState<string | null>(null);
  const rooms = useMemo(() => groupRooms(racks.data ?? [], t('dcim.unplaced')), [racks.data, t]);
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0] ?? null;
  const rack = room?.racks.find((r) => r.ci.id === rackId) ?? room?.racks[0] ?? null;
  const totals = useMemo(() => rooms.reduce((acc, r) => ({ racks: acc.racks + r.racks.length, rated: acc.rated + r.ratedWatts, current: acc.current + r.currentWatts, units: acc.units + r.units, occupied: acc.occupied + r.occupiedUnits }), { racks: 0, rated: 0, current: 0, units: 0, occupied: 0 }), [rooms]);

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('dcim.subtitle')}>
        {t('dcim.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi label={t('dcim.kpi.rooms')} value={format.integer(rooms.length)} />
        <Kpi label={t('dcim.kpi.racks')} value={format.integer(totals.racks)} />
        <Kpi label={t('dcim.kpi.power')} value={format.number(totals.current / POWER.wattsPerKilowatt)} unit={t('dcim.unit.kw')} />
        <Kpi label={t('dcim.kpi.occupancy')} value={format.number(percentOf(totals.occupied, totals.units))} unit="%" />
      </div>
      {racks.isPending ? (
        <QueryState status="pending" />
      ) : racks.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void racks.refetch();
          }}
        />
      ) : rooms.length === 0 ? (
        <Card padding="24">
          <p className="text-om-sm text-om-secondary">{t('dcim.empty')}</p>
        </Card>
      ) : (
        <>
          <Card padding="24" className="flex flex-col gap-om-12">
            <SectionTitle
              as="h2"
              size="sm"
              description={t('dcim.heatmap.subtitle')}
              action={
                <div className="flex flex-wrap gap-om-6" role="tablist" aria-label={t('dcim.kpi.rooms')}>
                  {rooms.map((r) => (
                    <Pill
                      key={r.id}
                      variant={room?.id === r.id ? 'primary' : 'default'}
                      onClick={() => {
                        setRoomId(r.id);
                        setRackId(null);
                      }}
                    >
                      {r.name}
                    </Pill>
                  ))}
                </div>
              }
            >
              {t('dcim.heatmap.title')}
            </SectionTitle>
            {room !== null ? (
              <>
                <div className="flex flex-wrap gap-om-12 text-om-xs text-om-secondary">
                  <span>{t('dcim.room.racks', { count: format.integer(room.racks.length) })}</span>
                  <span>{t('dcim.room.power', { current: format.number(room.currentWatts / POWER.wattsPerKilowatt), rated: format.number(room.ratedWatts / POWER.wattsPerKilowatt) })}</span>
                  {room.designKw !== null ? <span>{t('dcim.room.design', { kw: format.number(room.designKw) })}</span> : null}
                  <span>{t('dcim.room.occupancy', { percent: format.number(percentOf(room.occupiedUnits, room.units)) })}</span>
                </div>
                <div className="grid grid-cols-4 gap-om-6 sm:grid-cols-6 md:grid-cols-10 xl:grid-cols-12" role="listbox" aria-label={t('dcim.heatmap.title')}>
                  {room.racks.map((r) => {
                    const power = rackPower(r);
                    const powerPercent = percentOf(power.currentWatts, power.ratedWatts);
                    const occupancy = percentOf(r.occupiedUnits, r.units);
                    const selected = rack?.ci.id === r.ci.id;
                    return (
                      <button
                        key={r.ci.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={r.ci.displayName}
                        title={r.ci.displayName + ' · ' + format.number(powerPercent) + '% · ' + format.number(occupancy) + '%'}
                        onClick={() => {
                          setRackId(r.ci.id);
                        }}
                        className={cx('flex aspect-square flex-col items-center justify-center rounded-om-control border text-om-2xs font-om-mono transition-transform duration-om-base ease-om-standard hover:scale-105', selected ? 'border-om-cyan' : 'border-om-border-glass')}
                        style={{ background: heatAccent(powerPercent, occupancy) + '33', color: heatAccent(powerPercent, occupancy) }}
                      >
                        <span className="truncate px-om-4">{r.ci.name.split('-').slice(-DCIM.tileNameSegments).join('-')}</span>
                        <span>{format.integer(powerPercent) + '%'}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </Card>
          {rack !== null ? <RackPanel locale={locale} rack={rack} /> : null}
        </>
      )}
    </div>
  );
}

function RackPanel({ locale, rack }: { locale: Locale; rack: Rack }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const power = rackPower(rack);
  return (
    <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[1fr_2fr]">
      <section aria-label={t('dcim.elevation.title')}>
      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={[rack.room?.displayName, rack.row?.displayName].filter((x) => x !== undefined && x !== null).join(' · ')} action={<Icon name="dcim" className="size-5 text-om-violet" />}>
          {rack.ci.displayName}
        </SectionTitle>
        <RackElevation rack={rack} />
        <div className="flex flex-col gap-om-6 text-om-xs text-om-secondary">
          <span>{t('dcim.rack.units', { occupied: format.integer(rack.occupiedUnits), total: format.integer(rack.units) })}</span>
          <Bar value={rack.occupiedUnits} max={rack.units || 1} accent={accents.violet} />
          <span>{t('dcim.rack.power', { current: format.number(power.currentWatts / POWER.wattsPerKilowatt), rated: format.number(power.ratedWatts / POWER.wattsPerKilowatt) })}</span>
          <Bar value={power.currentWatts} max={power.ratedWatts || 1} accent={heatAccent(percentOf(power.currentWatts, power.ratedWatts), 0)} />
          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(rack.ci.id))} className="text-om-cyan hover:underline">
            {t('dcim.rack.openCi')}
          </Link>
        </div>
      </Card>
      </section>
      <div className="flex flex-col gap-om-16">
        <Card padding="24" className="flex flex-col gap-om-10">
          <SectionTitle as="h2" size="sm">
            {t('dcim.devices.title', { count: format.integer(rack.devices.length) })}
          </SectionTitle>
          {rack.devices.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('dcim.devices.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('dcim.devices.unit')}</th>
                    <th scope="col" className={thClass}>{t('dcim.devices.device')}</th>
                    <th scope="col" className={thClass}>{t('dcim.devices.type')}</th>
                    <th scope="col" className={thClass}>{t('dcim.devices.face')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rack.devices].sort((a, b) => b.startUnit - a.startUnit).map((d) => (
                    <tr key={d.ci.id} className={rowClass}>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>{unitRange(d.startUnit, d.heightUnits, format.integer)}</td>
                      <td className={tdClass}>
                        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(d.ci.id))} className="text-om-cyan hover:underline">
                          {d.ci.displayName}
                        </Link>
                      </td>
                      <td className={tdClass}>
                        <Tag>{d.ci.type}</Tag>
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>{t(('dcim.face.' + d.face) as MessageKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card padding="24" className="flex flex-col gap-om-10">
          <SectionTitle as="h2" size="sm">
            {t('dcim.power.title')}
          </SectionTitle>
          {rack.powerFeeds.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('dcim.power.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('dcim.power.feed')}</th>
                    <th scope="col" className={thClass}>{t('dcim.power.rated')}</th>
                    <th scope="col" className={thClass}>{t('dcim.power.current')}</th>
                    <th scope="col" className={thClass}>{t('dcim.power.load')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rack.powerFeeds.map((f) => {
                    const load = percentOf(f.currentWatts, f.ratedWatts);
                    return (
                      <tr key={f.ci.id} className={rowClass}>
                        <td className={tdClass}>
                          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(f.ci.id))} className="font-om-mono text-om-cyan hover:underline">
                            {f.ci.displayName}
                          </Link>
                        </td>
                        <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.number(f.ratedWatts / POWER.wattsPerKilowatt) + ' ' + t('dcim.unit.kw')}</td>
                        <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.number(f.currentWatts / POWER.wattsPerKilowatt) + ' ' + t('dcim.unit.kw')}</td>
                        <td className={tdClass}>
                          <span className="flex w-32 items-center gap-om-6">
                            <Bar value={load} accent={heatAccent(load, 0)} />
                            <span className="font-om-mono text-om-2xs text-om-secondary">{format.integer(load) + '%'}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** "U1" for a one-unit device, "U1–2" for a taller one. */
export function unitRange(start: number, height: number, integer: (n: number) => string): string {
  const top = start + height - 1;
  return 'U' + integer(start) + (top > start ? '–' + integer(top) : '');
}

/** Isometric front elevation: the rack frame with a depth face, one slot per unit, devices as plates with their layer colour. */
export function plateLabel(name: string): string {
  return name.length > DCIM.labelMaxChars ? name.slice(0, DCIM.labelMaxChars - 1) + '…' : name;
}

export function RackElevation({ rack }: { rack: Rack }): ReactNode {
  const t = useT();
  const units = Math.max(rack.units, rack.devices.reduce((m, d) => Math.max(m, d.startUnit + d.heightUnits - 1), 0), 1);
  const width = DCIM.rackWidthPx;
  const pad = DCIM.rackPaddingPx;
  const depth = DCIM.isoDepthPx;
  const height = units * DCIM.unitHeightPx;
  const totalW = width + pad + pad + depth;
  const totalH = height + pad + pad + depth;
  const unitTop = (u: number): number => pad + depth + (units - u) * DCIM.unitHeightPx;
  return (
    <svg viewBox={'0 0 ' + String(totalW) + ' ' + String(totalH)} role="img" aria-label={t('dcim.elevation.aria', { name: rack.ci.displayName, units: String(units) })} className="w-full max-w-md self-center">
      <defs>
        <linearGradient id="om-rack-face" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={accents.violet} stopOpacity="0.25" />
          <stop offset="1" stopColor={accents.cyan} stopOpacity="0.08" />
        </linearGradient>
      </defs>
      {/* depth face (top and side) */}
      <polygon points={[pad, pad + depth, pad + depth, pad, pad + depth + width, pad, pad + width, pad + depth].join(' ')} fill={accents.violet} fillOpacity="0.18" />
      <polygon points={[pad + width, pad + depth, pad + depth + width, pad, pad + depth + width, pad + height, pad + width, pad + depth + height].join(' ')} fill={accents.violet} fillOpacity="0.1" />
      {/* frame */}
      <rect x={pad} y={pad + depth} width={width} height={height} rx="4" fill="url(#om-rack-face)" stroke={accents.violet} strokeOpacity="0.6" />
      {Array.from({ length: units }, (_, i) => i + 1).map((u) => (
        <g key={u}>
          <line x1={pad} x2={pad + width} y1={unitTop(u)} y2={unitTop(u)} stroke={accents.cyan} strokeOpacity="0.08" />
          {u % DCIM.unitLabelEvery === 0 || u === 1 ? (
            <text x={pad - DCIM.unitLabelOffsetPx} y={unitTop(u) + DCIM.unitHeightPx - DCIM.unitLabelBaselinePx} textAnchor="end" fontSize="8" fill={accents.cyan} fillOpacity="0.6" fontFamily="monospace">
              {u}
            </text>
          ) : null}
        </g>
      ))}
      {rack.devices.map((d) => {
        const top = unitTop(d.startUnit + d.heightUnits - 1);
        const h = d.heightUnits * DCIM.unitHeightPx - DCIM.unitGapPx;
        const colour = layerColor(d.ci.layer);
        return (
          <g key={d.ci.id}>
            <rect x={pad + DCIM.plateInsetPx} y={top + 1} width={width - DCIM.plateInsetPx * DCIM.unitGapPx} height={h} rx="2" fill={colour} fillOpacity="0.35" stroke={colour} strokeOpacity="0.9" />
            <text x={pad + DCIM.plateTextInsetPx} y={top + h / DCIM.unitGapPx + DCIM.unitLabelBaselinePx} fontSize="8" fill={text.primary} fontFamily="monospace">
              {plateLabel(d.ci.name)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
