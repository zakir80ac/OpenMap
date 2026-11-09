'use client';
// REQ-DCIM-003 (ADR-057) — the DCIM floor plan: a room's rows in their order along the room, each with its aisle and
// its rack slots, every rack coloured by the chosen measure (power against its feeds' rating, against its design
// power, or units in use); racks with no reading stay uncoloured. Choosing a rack shows its readings and, for
// operators, moves it to another slot of a row in the same room (a free slot chosen on the plan fills the form).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CONSOLE_ALPHA, ROLES } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Pill, SectionTitle, Segmented, Tag, cx, stateColor, withAlpha } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Select, TextInput } from '@/components/common/controls';
import { useCan } from '@/lib/auth';
import { placeRack, type Rack } from '@/lib/estate-queries';
import {
  HEAT_MEASURES,
  buildFloorPlan,
  heatOf,
  heatState,
  type FloorRoom,
  type HeatMeasure,
} from '@/lib/floor-plan';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const BANDS = ['healthy', 'at_risk', 'down', 'unknown'] as const;

export function FloorPlanView({ locale, racks }: { locale: Locale; racks: readonly Rack[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const [measure, setMeasure] = useState<HeatMeasure>('power');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [rackId, setRackId] = useState<string | null>(null);
  const [target, setTarget] = useState({ rowId: '', position: '' });
  const plan = useMemo(() => buildFloorPlan(racks, measure, t('dcim.unplaced')), [racks, measure, t]);
  const room: FloorRoom | null = plan.find((r) => r.id === roomId) ?? plan[0] ?? null;
  const rack = racks.find((r) => r.ci.id === rackId) ?? null;
  const move = useMutation({
    mutationFn: () => placeRack(rackId ?? '', target.rowId, Number(target.position)),
    onSuccess: () => {
      setTarget({ rowId: '', position: '' });
      void queryClient.invalidateQueries({ queryKey: ['racks'] });
    },
  });
  const pct = (v: number | null): string =>
    v === null ? t('dcim.floor.noReading') : t('dcim.floor.percent', { value: format.number(v) });

  if (room === null) return null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    move.mutate();
  };

  return (
    <div className="flex flex-col gap-om-24">
      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('dcim.floor.subtitle')}
          action={
            <Segmented
              label={t('dcim.floor.measure')}
              value={measure}
              onChange={setMeasure}
              options={HEAT_MEASURES.map((m) => ({
                value: m,
                label: t(('dcim.floor.measures.' + m) as MessageKey),
              }))}
            />
          }
        >
          {t('dcim.floor.title')}
        </SectionTitle>
        <div className="flex flex-wrap gap-om-6" role="group" aria-label={t('dcim.floor.rooms')}>
          {plan.map((r) => (
            <Pill
              key={r.id}
              variant={room.id === r.id ? 'primary' : 'default'}
              onClick={() => {
                setRoomId(r.id);
                setRackId(null);
              }}
            >
              {r.name}
            </Pill>
          ))}
        </div>
        <ul
          className="flex flex-wrap gap-om-12 text-om-2xs text-om-secondary"
          aria-label={t('dcim.floor.legend')}
        >
          {BANDS.map((b) => (
            <li key={b} className="flex items-center gap-om-6">
              <span
                className="inline-block size-3 rounded-om-control"
                style={{ background: stateColor(b) }}
              />
              {t(('dcim.floor.band.' + b) as MessageKey)}
            </li>
          ))}
        </ul>
        <section
          aria-label={t('dcim.floor.plan', { room: room.name })}
          className="flex flex-col gap-om-10 overflow-x-auto"
        >
          {room.rows.map((row) => (
            <div key={row.id ?? row.name} className="flex flex-col gap-om-6">
              <div className="flex items-center gap-om-8 text-om-xs">
                <span className="font-semibold text-om-primary">{row.name}</span>
                {row.aisle === null ? null : (
                  <Tag variant="state" state={row.aisle === 'cold' ? 'healthy' : 'at_risk'}>
                    {t(('dcim.floor.aisle.' + row.aisle) as MessageKey)}
                  </Tag>
                )}
              </div>
              <ul className="flex gap-om-4" aria-label={t('dcim.floor.row', { row: row.name })}>
                {row.slots.map((slot) => {
                  const state = heatState(slot.heat);
                  const selected = slot.rack !== null && slot.rack.ci.id === rackId;
                  const label =
                    slot.rack === null
                      ? t('dcim.floor.freeSlot', { row: row.name, slot: String(slot.position) })
                      : t('dcim.floor.rackSlot', {
                          row: row.name,
                          slot: String(slot.position),
                          rack: slot.rack.ci.displayName,
                          heat: pct(slot.heat),
                        });
                  return (
                    <li key={slot.position}>
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={selected}
                        title={label}
                        onClick={() => {
                          if (slot.rack !== null) {
                            setRackId(slot.rack.ci.id);
                            return;
                          }
                          if (row.id !== null) setTarget({ rowId: row.id, position: String(slot.position) });
                        }}
                        className={cx(
                          'flex h-16 w-12 flex-col items-center justify-end rounded-om-control border pb-om-4 font-mono text-om-2xs transition-colors duration-om-fast',
                          slot.rack === null
                            ? 'border-dashed border-om-border-glass text-om-muted'
                            : 'border-om-border-strong text-om-primary',
                          selected && 'ring-2 ring-om-cyan',
                        )}
                        style={
                          slot.rack === null
                            ? undefined
                            : { background: withAlpha(stateColor(state), CONSOLE_ALPHA.heatTile) }
                        }
                      >
                        {slot.position}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      </Card>

      {rack !== null ? (
        <Card padding="24" className="flex flex-col gap-om-12">
          <SectionTitle
            as="h2"
            size="sm"
            description={t('dcim.floor.rackPlace', {
              row: rack.row?.displayName ?? t('dcim.unplaced'),
              slot: String(rack.ci.attributes['position'] ?? ''),
            })}
            action={
              <Link href={localizedHref(locale, '/twin')} className="text-om-xs text-om-cyan hover:underline">
                {t('dcim.floor.openTwin')}
              </Link>
            }
          >
            {rack.ci.displayName}
          </SectionTitle>
          <dl className="grid grid-cols-1 gap-om-8 text-om-xs sm:grid-cols-3">
            {HEAT_MEASURES.map((m) => (
              <div key={m} className="flex flex-col gap-om-2">
                <dt className="text-om-muted">{t(('dcim.floor.measures.' + m) as MessageKey)}</dt>
                <dd className="font-mono text-om-primary">{pct(heatOf(rack, m))}</dd>
              </div>
            ))}
          </dl>
          {can(ROLES.operator) ? (
            <form
              aria-label={t('dcim.floor.move')}
              onSubmit={submit}
              className="flex flex-wrap items-end gap-om-10"
            >
              <label className={labelClass}>
                {t('dcim.floor.toRow')}
                <Select
                  required
                  value={target.rowId}
                  onChange={(e) => setTarget({ ...target, rowId: e.target.value })}
                >
                  <option value="">{t('dcim.floor.chooseRow')}</option>
                  {room.rows
                    .filter((r) => r.id !== null)
                    .map((r) => (
                      <option key={r.id} value={r.id ?? ''}>
                        {r.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label className={labelClass}>
                {t('dcim.floor.toSlot')}
                <TextInput
                  required
                  type="number"
                  min={1}
                  value={target.position}
                  onChange={(e) => setTarget({ ...target, position: e.target.value })}
                  className="w-24"
                />
              </label>
              <Button type="submit" disabled={move.isPending}>
                {t('dcim.floor.move')}
              </Button>
            </form>
          ) : null}
          {move.isError ? (
            <p role="alert" className="text-om-xs text-om-state-down">
              {move.error.message}
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
