'use client';
// REQ-DCIM-001 REQ-DCIM-008 (ADR-056, ADR-062) — the DCIM Cabling tab:
// - totals (patch panels, positions in use, cables, cross-connects, circuits);
// - patch panels with their rack, rack unit, media and use; the selected panel's positions as a grid, each showing the
//   cable on its front and rear and a circuit terminated there;
// - cables (patch leads, trunks, cross-connects) with both ends, and carrier circuits with their terminations;
// - the trace of a path from any cable end or panel position, through the panels to the far end;
// - for operators: mount a patch panel in a rack, connect a cable between two ports (a panel position needs a side),
//   disconnect one, record a circuit, remove a circuit or a panel with nothing on it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CABLING, CONSOLE, ROLES } from '@openmap/constants';
import {
  CABLE_KINDS,
  CABLE_MEDIA,
  CIRCUIT_KINDS,
  CIRCUIT_STATUSES,
  PANEL_CONNECTORS,
  PANEL_SIDES,
  type CableKind,
  type CableMedia,
  type CircuitKind,
  type CircuitStatus,
  type PanelConnector,
  type PanelSide,
} from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, SectionTitle, Tag, accents, cx } from '@openmap/ui';
import { useMemo, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';
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
  cableTraceQuery,
  cablingKey,
  cablingQuery,
  connectCable,
  disconnectCable,
  removeCircuit,
  removePatchPanel,
  saveCircuit,
  savePatchPanel,
  type CableEnd,
  type CablingCi,
  type EndpointInput,
  type ObservedLink,
  type PatchPanel,
} from '@/lib/cabling-queries';
import type { Rack } from '@/lib/estate-queries';
import { searchQuery } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { CableVerificationPanel } from './CableVerificationPanel';
import { useFormatters, useT, type Translate } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const STATUS_STATE = {
  planned: 'unknown',
  provisioning: 'at_risk',
  active: 'healthy',
  decommissioned: 'degraded',
} as const satisfies Record<CircuitStatus, 'healthy' | 'degraded' | 'at_risk' | 'unknown'>;

interface Draft {
  ciId: string;
  port: string;
  side: '' | PanelSide;
}
const NO_END: Draft = { ciId: '', port: '', side: '' };
const NO_KNOWN: readonly CablingCi[] = [];

function toEndpoint(d: Draft): EndpointInput | null {
  if (d.ciId === '') return null;
  const port = d.port.trim();
  return { ciId: d.ciId, port: port === '' ? null : port, side: d.side === '' ? null : d.side };
}

function optional(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function optionalNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

export function endLabel(
  t: Translate,
  e: { ci: { name: string }; port: string | null; side: PanelSide | null },
): string {
  if (e.port === null) return e.ci.name;
  if (e.side === null) return t('dcim.cabling.endPort', { ci: e.ci.name, port: e.port });
  return t('dcim.cabling.endSide', {
    ci: e.ci.name,
    port: e.port,
    side: t(('dcim.cabling.side.' + e.side) as MessageKey),
  });
}

/** A cable or circuit end: a CI found by search (patch panels are always offered), the port on it and a panel side. */
function EndpointPicker({
  legend,
  value,
  onChange,
  panels,
  known = NO_KNOWN,
}: {
  legend: string;
  value: Draft;
  onChange: (d: Draft) => void;
  panels: readonly PatchPanel[];
  /** CIs offered without a search: the ends of an observed link a cable is being recorded for (REQ-DCIM-008). */
  known?: readonly CablingCi[];
}): ReactNode {
  const t = useT();
  const [text, setText] = useState('');
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);
  const hits = useQuery(
    searchQuery({ text: debounced, layers: [...CABLING.endpointLayers], first: CABLING.endpointSearchLimit }),
  );
  const options = useMemo(() => {
    const byId = new Map<string, CablingCi>();
    for (const p of panels) byId.set(p.ci.id, p.ci);
    for (const k of known) byId.set(k.id, k);
    for (const h of hits.data ?? [])
      if (h.ci.type !== 'cable' && h.ci.type !== 'circuit')
        byId.set(h.ci.id, { id: h.ci.id, name: h.ci.name, type: h.ci.type });
    return [...byId.values()];
  }, [panels, known, hits.data]);
  const isPanel = panels.some((p) => p.ci.id === value.ciId);
  return (
    <fieldset className="flex flex-wrap items-end gap-om-10 rounded-om-control border border-om-border-glass p-om-10">
      <legend className="px-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-secondary">
        {legend}
      </legend>
      <label className={labelClass}>
        {t('dcim.cabling.endpoint.search')}
        <TextInput
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      </label>
      <label className={labelClass}>
        {t('dcim.cabling.endpoint.ci')}
        <Select
          value={value.ciId}
          onChange={(e) => {
            const panel = panels.some((p) => p.ci.id === e.target.value);
            onChange({
              ...value,
              ciId: e.target.value,
              side: panel ? (value.side === '' ? 'front' : value.side) : '',
            });
          }}
        >
          <option value="">{t('dcim.cabling.endpoint.choose')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {t('dcim.cabling.endpoint.option', { name: o.name, type: o.type })}
            </option>
          ))}
        </Select>
      </label>
      <label className={labelClass}>
        {isPanel ? t('dcim.cabling.endpoint.position') : t('dcim.cabling.endpoint.port')}
        <TextInput
          value={value.port}
          required={isPanel}
          onChange={(e) => {
            onChange({ ...value, port: e.target.value });
          }}
          className="w-28"
        />
      </label>
      {isPanel ? (
        <label className={labelClass}>
          {t('dcim.cabling.endpoint.side')}
          <Select
            value={value.side}
            onChange={(e) => {
              onChange({ ...value, side: e.target.value as PanelSide });
            }}
          >
            {PANEL_SIDES.map((s) => (
              <option key={s} value={s}>
                {t(('dcim.cabling.side.' + s) as MessageKey)}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </fieldset>
  );
}

function PositionGrid({
  panel,
  onTrace,
}: {
  panel: PatchPanel;
  onTrace: (e: EndpointInput) => void;
}): ReactNode {
  const t = useT();
  return (
    <ul
      className="grid grid-cols-6 gap-om-4 sm:grid-cols-12 xl:grid-cols-24"
      aria-label={t('dcim.cabling.positions', { panel: panel.ci.name })}
    >
      {panel.positions.map((p) => {
        const sides = (p.front === null ? 0 : 1) + (p.rear === null ? 0 : 1);
        const detail = [
          p.front === null ? null : t('dcim.cabling.frontCable', { label: p.front.label }),
          p.rear === null ? null : t('dcim.cabling.rearCable', { label: p.rear.label }),
          p.circuit === null ? null : t('dcim.cabling.circuitOn', { circuit: p.circuit.circuitId }),
        ].filter((x): x is string => x !== null);
        return (
          <li key={p.position}>
            <button
              type="button"
              title={detail.length === 0 ? t('dcim.cabling.free') : detail.join('\n')}
              aria-label={
                t('dcim.cabling.position', { position: String(p.position) }) +
                (detail.length === 0 ? '' : ': ' + detail.join(', '))
              }
              onClick={() => {
                onTrace({
                  ciId: panel.ci.id,
                  port: String(p.position),
                  side: p.front === null && p.rear !== null ? 'rear' : 'front',
                });
              }}
              className={cx(
                'w-full rounded-om-control border border-om-border-glass py-om-4 text-center font-mono text-om-2xs text-om-primary transition-colors duration-om-fast hover:border-om-cyan',
                p.circuit !== null
                  ? 'bg-om-violet/20'
                  : sides === 0
                    ? 'bg-om-surface3'
                    : sides === 1
                      ? 'bg-om-cyan/10'
                      : 'bg-om-cyan/25',
              )}
            >
              {p.position}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TraceCard({ start, onClose }: { start: EndpointInput; onClose: () => void }): ReactNode {
  const t = useT();
  const trace = useQuery(cableTraceQuery(start));
  return (
    <Card padding="24" className="flex flex-col gap-om-12">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('dcim.cabling.trace.subtitle')}
        action={
          <Button tone="quiet" onClick={onClose}>
            {t('dcim.cabling.trace.close')}
          </Button>
        }
      >
        {t('dcim.cabling.trace.title')}
      </SectionTitle>
      {trace.isPending ? (
        <QueryState status="pending" />
      ) : trace.isError ? (
        <QueryState status="error" onRetry={() => void trace.refetch()} />
      ) : trace.data.hops.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('dcim.cabling.trace.nothing')}</p>
      ) : (
        <>
          <ol className="flex flex-col gap-om-6" aria-label={t('dcim.cabling.trace.title')}>
            {trace.data.hops.map((h, i) => (
              <li key={h.via.id + String(i)} className="flex flex-wrap items-center gap-om-8 text-om-xs">
                <span className="font-mono text-om-primary">{endLabel(t, h.from)}</span>
                <Tag>{t(('dcim.cabling.via.' + h.viaKind) as MessageKey, { name: h.via.name })}</Tag>
                <span className="font-mono text-om-primary">{endLabel(t, h.to)}</span>
              </li>
            ))}
          </ol>
          <Tag variant="state" state={trace.data.complete ? 'healthy' : 'at_risk'}>
            {trace.data.looped
              ? t('dcim.cabling.trace.looped')
              : trace.data.complete
                ? t('dcim.cabling.trace.complete')
                : t('dcim.cabling.trace.incomplete')}
          </Tag>
        </>
      )}
    </Card>
  );
}

export function CablingView({ racks }: { racks: readonly Rack[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const operator = can(ROLES.operator);
  const queryClient = useQueryClient();
  const cabling = useQuery(cablingQuery());
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: cablingKey });
    void queryClient.invalidateQueries({ queryKey: ['cable-trace'] });
  };
  const [panelId, setPanelId] = useState<string | null>(null);
  const [traceFrom, setTraceFrom] = useState<EndpointInput | null>(null);
  const [known, setKnown] = useState<readonly CablingCi[]>(NO_KNOWN);
  const cableFormRef = useRef<HTMLFormElement>(null);
  /** REQ-DCIM-008: starts the cable form from an observed link nobody recorded: its label and both device ports. */
  const recordLink = (link: ObservedLink): void => {
    setKnown([link.a.ci, link.b.ci]);
    setCableForm((f) => ({
      ...f,
      label: link.suggestedLabel,
      a: { ciId: link.a.ci.id, port: link.a.port ?? '', side: '' },
      b: { ciId: link.b.ci.id, port: link.b.port ?? '', side: '' },
    }));
    // The form sits below the tables; bring it into view where the browser can (not every test DOM implements it).
    const form = cableFormRef.current;
    if (form !== null && typeof form.scrollIntoView === 'function') form.scrollIntoView({ block: 'center' });
  };
  const [panelForm, setPanelForm] = useState({
    rackId: '',
    name: '',
    ports: '',
    media: 'cat6a' as CableMedia,
    connector: 'rj45' as PanelConnector,
    uPosition: '',
  });
  const [cableForm, setCableForm] = useState({
    label: '',
    kind: 'patch' as CableKind,
    media: 'cat6a' as CableMedia,
    lengthM: '',
    colour: '',
    a: NO_END,
    b: NO_END,
  });
  const [circuitForm, setCircuitForm] = useState({
    provider: '',
    circuitId: '',
    kind: 'internet' as CircuitKind,
    status: 'active' as CircuitStatus,
    bandwidthMbps: '',
    aEnd: NO_END,
    zEndDescription: '',
  });

  const savePanel = useMutation({
    mutationFn: () =>
      savePatchPanel({
        rackId: panelForm.rackId,
        name: panelForm.name.trim(),
        ports: Number(panelForm.ports),
        media: panelForm.media,
        connector: panelForm.connector,
        uPosition: optionalNumber(panelForm.uPosition),
      }),
    onSuccess: (panel) => {
      setPanelForm((f) => ({ ...f, name: '' }));
      setPanelId(panel.ci.id);
      refresh();
    },
  });
  const connect = useMutation({
    mutationFn: () => {
      const a = toEndpoint(cableForm.a);
      const b = toEndpoint(cableForm.b);
      if (a === null || b === null) throw new Error(t('dcim.cabling.bothEnds'));
      return connectCable({
        label: cableForm.label.trim(),
        kind: cableForm.kind,
        media: cableForm.media,
        lengthM: optionalNumber(cableForm.lengthM),
        colour: optional(cableForm.colour),
        a,
        b,
      });
    },
    onSuccess: () => {
      setCableForm((f) => ({ ...f, label: '', a: NO_END, b: NO_END }));
      refresh();
    },
  });
  const disconnect = useMutation({ mutationFn: (id: string) => disconnectCable(id), onSuccess: refresh });
  const removePanel = useMutation({ mutationFn: (id: string) => removePatchPanel(id), onSuccess: refresh });
  const dropCircuit = useMutation({ mutationFn: (id: string) => removeCircuit(id), onSuccess: refresh });
  const circuit = useMutation({
    mutationFn: () =>
      saveCircuit({
        provider: circuitForm.provider.trim(),
        circuitId: circuitForm.circuitId.trim(),
        kind: circuitForm.kind,
        status: circuitForm.status,
        bandwidthMbps: optionalNumber(circuitForm.bandwidthMbps),
        aEnd: toEndpoint(circuitForm.aEnd),
        zEnd: null,
        zEndDescription: optional(circuitForm.zEndDescription),
      }),
    onSuccess: () => {
      setCircuitForm((f) => ({
        ...f,
        provider: '',
        circuitId: '',
        bandwidthMbps: '',
        aEnd: NO_END,
        zEndDescription: '',
      }));
      refresh();
    },
  });
  const failed = [savePanel, connect, disconnect, circuit, removePanel, dropCircuit].find((m) => m.isError);

  if (cabling.isPending) return <QueryState status="pending" />;
  if (cabling.isError) return <QueryState status="error" onRetry={() => void cabling.refetch()} />;
  const data = cabling.data;
  const panel = data.patchPanels.find((p) => p.ci.id === panelId) ?? data.patchPanels[0] ?? null;
  const submit =
    (run: () => void) =>
    (event: SyntheticEvent<HTMLFormElement>): void => {
      event.preventDefault();
      run();
    };
  const traceButton = (e: CableEnd): ReactNode => (
    <button
      type="button"
      className="text-start font-mono text-om-primary underline-offset-2 hover:underline"
      aria-label={t('dcim.cabling.trace.from', { end: endLabel(t, e) })}
      onClick={() => {
        setTraceFrom({ ciId: e.ci.id, port: e.port, side: e.side });
      }}
    >
      {endLabel(t, e)}
    </button>
  );

  return (
    <div className="flex flex-col gap-om-24">
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-5">
        <Kpi label={t('dcim.cabling.kpi.panels')} value={format.integer(data.summary.patchPanels)} />
        <Kpi
          label={t('dcim.cabling.kpi.positions')}
          value={format.integer(data.summary.positionsUsed)}
          unit={t('dcim.cabling.kpi.of', { total: format.integer(data.summary.positions) })}
        />
        <Kpi label={t('dcim.cabling.kpi.cables')} value={format.integer(data.summary.cables)} />
        <Kpi label={t('dcim.cabling.kpi.crossConnects')} value={format.integer(data.summary.crossConnects)} />
        <Kpi label={t('dcim.cabling.kpi.circuits')} value={format.integer(data.summary.circuits)} />
      </div>

      {failed !== undefined ? (
        <p role="alert" className="text-om-xs text-om-state-down">
          {failed.error.message}
        </p>
      ) : null}
      {traceFrom !== null ? (
        <TraceCard
          start={traceFrom}
          onClose={() => {
            setTraceFrom(null);
          }}
        />
      ) : null}

      <CableVerificationPanel operator={operator} onRecord={recordLink} />

      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('dcim.cabling.panels.subtitle')}>
          {t('dcim.cabling.panels.title')}
        </SectionTitle>
        {data.patchPanels.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('dcim.cabling.panels.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass} aria-label={t('dcim.cabling.panels.title')}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>{t('dcim.cabling.panel')}</th>
                  <th className={thClass}>{t('dcim.cabling.rack')}</th>
                  <th className={thClass}>{t('dcim.cabling.unit')}</th>
                  <th className={thClass}>{t('dcim.cabling.media')}</th>
                  <th className={thClass}>{t('dcim.cabling.used')}</th>
                  {operator ? <th className={thClass}>{t('dcim.cabling.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.patchPanels.map((p) => (
                  <tr key={p.ci.id} className={cx(rowClass, panel?.ci.id === p.ci.id && 'bg-om-cyan/8')}>
                    <td className={tdClass}>
                      <button
                        type="button"
                        className="font-mono text-om-primary hover:underline"
                        onClick={() => {
                          setPanelId(p.ci.id);
                        }}
                      >
                        {p.name}
                      </button>
                    </td>
                    <td className={tdClass}>{p.rack?.name ?? t('dcim.unplaced')}</td>
                    <td className={tdClass}>
                      {p.uPosition === null
                        ? ''
                        : t('dcim.cabling.unitValue', { u: format.integer(p.uPosition) })}
                    </td>
                    <td className={tdClass}>
                      {p.media === null ? '' : t(('dcim.cabling.mediaName.' + p.media) as MessageKey)}
                      {p.connector === null ? null : (
                        <span className="ms-om-6 text-om-muted">
                          {t(('dcim.cabling.connector.' + p.connector) as MessageKey)}
                        </span>
                      )}
                    </td>
                    <td className={cx(tdClass, 'min-w-40')}>
                      <Bar
                        value={p.used}
                        max={p.ports || 1}
                        accent={accents.cyan}
                        label={t('dcim.cabling.usedOf', {
                          used: format.integer(p.used),
                          total: format.integer(p.ports),
                        })}
                      />
                    </td>
                    {operator ? (
                      <td className={tdClass}>
                        <Button
                          tone="danger"
                          disabled={removePanel.isPending}
                          aria-label={t('dcim.cabling.removePanel', { name: p.ci.name })}
                          onClick={() => { removePanel.mutate(p.ci.id); }}
                        >
                          {t('dcim.cabling.remove')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {panel !== null ? <PositionGrid panel={panel} onTrace={setTraceFrom} /> : null}
        {operator ? (
          <form
            aria-label={t('dcim.cabling.panelForm')}
            onSubmit={submit(() => { savePanel.mutate(); })}
            className="flex flex-wrap items-end gap-om-10"
          >
            <label className={labelClass}>
              {t('dcim.cabling.rack')}
              <Select
                required
                value={panelForm.rackId}
                onChange={(e) => { setPanelForm({ ...panelForm, rackId: e.target.value }); }}
              >
                <option value="">{t('dcim.cabling.chooseRack')}</option>
                {racks.map((r) => (
                  <option key={r.ci.id} value={r.ci.id}>
                    {r.ci.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              {t('dcim.cabling.panelName')}
              <TextInput
                required
                value={panelForm.name}
                onChange={(e) => { setPanelForm({ ...panelForm, name: e.target.value }); }}
              />
            </label>
            <label className={labelClass}>
              {t('dcim.cabling.ports')}
              <TextInput
                required
                type="number"
                min={1}
                max={CABLING.maxPanelPorts}
                value={panelForm.ports}
                onChange={(e) => { setPanelForm({ ...panelForm, ports: e.target.value }); }}
                className="w-24"
              />
            </label>
            <label className={labelClass}>
              {t('dcim.cabling.media')}
              <Select
                value={panelForm.media}
                onChange={(e) => { setPanelForm({ ...panelForm, media: e.target.value as CableMedia }); }}
              >
                {CABLE_MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {t(('dcim.cabling.mediaName.' + m) as MessageKey)}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              {t('dcim.cabling.connectorLabel')}
              <Select
                value={panelForm.connector}
                onChange={(e) => { setPanelForm({ ...panelForm, connector: e.target.value as PanelConnector }); }}
              >
                {PANEL_CONNECTORS.map((c) => (
                  <option key={c} value={c}>
                    {t(('dcim.cabling.connector.' + c) as MessageKey)}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              {t('dcim.cabling.unit')}
              <TextInput
                type="number"
                min={1}
                value={panelForm.uPosition}
                onChange={(e) => { setPanelForm({ ...panelForm, uPosition: e.target.value }); }}
                className="w-20"
              />
            </label>
            <Button type="submit" disabled={savePanel.isPending}>
              {t('dcim.cabling.panelForm')}
            </Button>
          </form>
        ) : null}
      </Card>

      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('dcim.cabling.cables.subtitle')}>
          {t('dcim.cabling.cables.title')}
        </SectionTitle>
        {data.cables.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('dcim.cabling.cables.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass} aria-label={t('dcim.cabling.cables.title')}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>{t('dcim.cabling.label')}</th>
                  <th className={thClass}>{t('dcim.cabling.kind')}</th>
                  <th className={thClass}>{t('dcim.cabling.media')}</th>
                  <th className={thClass}>{t('dcim.cabling.endA')}</th>
                  <th className={thClass}>{t('dcim.cabling.endB')}</th>
                  {operator ? <th className={thClass}>{t('dcim.cabling.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.cables.map((c) => (
                  <tr key={c.ci.id} className={rowClass}>
                    <td className={cx(tdClass, 'font-mono text-om-primary')}>{c.label}</td>
                    <td className={tdClass}>
                      {c.kind === null ? (
                        ''
                      ) : (
                        <Tag>{t(('dcim.cabling.kindName.' + c.kind) as MessageKey)}</Tag>
                      )}
                    </td>
                    <td className={tdClass}>
                      {c.media === null ? '' : t(('dcim.cabling.mediaName.' + c.media) as MessageKey)}
                      {c.lengthM === null ? null : (
                        <span className="ms-om-6 text-om-muted">
                          {t('dcim.cabling.length', { m: format.number(c.lengthM) })}
                        </span>
                      )}
                    </td>
                    <td className={tdClass}>{traceButton(c.a)}</td>
                    <td className={tdClass}>{traceButton(c.b)}</td>
                    {operator ? (
                      <td className={tdClass}>
                        <Button
                          tone="danger"
                          disabled={disconnect.isPending}
                          aria-label={t('dcim.cabling.disconnectCable', { label: c.label })}
                          onClick={() => { disconnect.mutate(c.ci.id); }}
                        >
                          {t('dcim.cabling.disconnect')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {operator ? (
          <form
            ref={cableFormRef}
            aria-label={t('dcim.cabling.cableForm')}
            onSubmit={submit(() => { connect.mutate(); })}
            className="flex flex-col gap-om-10"
          >
            <div className="flex flex-wrap items-end gap-om-10">
              <label className={labelClass}>
                {t('dcim.cabling.label')}
                <TextInput
                  required
                  value={cableForm.label}
                  onChange={(e) => { setCableForm({ ...cableForm, label: e.target.value }); }}
                />
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.kind')}
                <Select
                  value={cableForm.kind}
                  onChange={(e) => { setCableForm({ ...cableForm, kind: e.target.value as CableKind }); }}
                >
                  {CABLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(('dcim.cabling.kindName.' + k) as MessageKey)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.media')}
                <Select
                  value={cableForm.media}
                  onChange={(e) => { setCableForm({ ...cableForm, media: e.target.value as CableMedia }); }}
                >
                  {CABLE_MEDIA.map((m) => (
                    <option key={m} value={m}>
                      {t(('dcim.cabling.mediaName.' + m) as MessageKey)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.lengthM')}
                <TextInput
                  type="number"
                  min={0}
                  step="any"
                  value={cableForm.lengthM}
                  onChange={(e) => { setCableForm({ ...cableForm, lengthM: e.target.value }); }}
                  className="w-24"
                />
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.colour')}
                <TextInput
                  value={cableForm.colour}
                  onChange={(e) => { setCableForm({ ...cableForm, colour: e.target.value }); }}
                  className="w-28"
                />
              </label>
            </div>
            <EndpointPicker
              legend={t('dcim.cabling.endA')}
              value={cableForm.a}
              onChange={(a) => { setCableForm({ ...cableForm, a }); }}
              panels={data.patchPanels}
              known={known}
            />
            <EndpointPicker
              legend={t('dcim.cabling.endB')}
              value={cableForm.b}
              onChange={(b) => { setCableForm({ ...cableForm, b }); }}
              panels={data.patchPanels}
              known={known}
            />
            <div>
              <Button type="submit" disabled={connect.isPending}>
                {t('dcim.cabling.cableForm')}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('dcim.cabling.circuits.subtitle')}>
          {t('dcim.cabling.circuits.title')}
        </SectionTitle>
        {data.circuits.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('dcim.cabling.circuits.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass} aria-label={t('dcim.cabling.circuits.title')}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>{t('dcim.cabling.provider')}</th>
                  <th className={thClass}>{t('dcim.cabling.circuitId')}</th>
                  <th className={thClass}>{t('dcim.cabling.kind')}</th>
                  <th className={thClass}>{t('dcim.cabling.status')}</th>
                  <th className={thClass}>{t('dcim.cabling.bandwidth')}</th>
                  <th className={thClass}>{t('dcim.cabling.endA')}</th>
                  <th className={thClass}>{t('dcim.cabling.endZ')}</th>
                  {operator ? <th className={thClass}>{t('dcim.cabling.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.circuits.map((c) => (
                  <tr key={c.ci.id} className={rowClass}>
                    <td className={tdClass}>{c.provider}</td>
                    <td className={cx(tdClass, 'font-mono text-om-primary')}>{c.circuitId}</td>
                    <td className={tdClass}>
                      {c.kind === null ? '' : t(('dcim.cabling.circuitKind.' + c.kind) as MessageKey)}
                    </td>
                    <td className={tdClass}>
                      {c.status === null ? (
                        ''
                      ) : (
                        <Tag variant="state" state={STATUS_STATE[c.status]}>
                          {t(('dcim.cabling.circuitStatus.' + c.status) as MessageKey)}
                        </Tag>
                      )}
                    </td>
                    <td className={tdClass}>
                      {c.bandwidthMbps === null
                        ? ''
                        : t('dcim.cabling.mbps', { mbps: format.integer(c.bandwidthMbps) })}
                    </td>
                    <td className={tdClass}>{c.aEnd === null ? '' : traceButton(c.aEnd)}</td>
                    <td className={tdClass}>
                      {c.zEnd !== null ? traceButton(c.zEnd) : (c.zEndDescription ?? '')}
                    </td>
                    {operator ? (
                      <td className={tdClass}>
                        <Button
                          tone="danger"
                          disabled={dropCircuit.isPending}
                          aria-label={t('dcim.cabling.removeCircuit', { circuit: c.circuitId })}
                          onClick={() => { dropCircuit.mutate(c.ci.id); }}
                        >
                          {t('dcim.cabling.remove')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {operator ? (
          <form
            aria-label={t('dcim.cabling.circuitForm')}
            onSubmit={submit(() => { circuit.mutate(); })}
            className="flex flex-col gap-om-10"
          >
            <div className="flex flex-wrap items-end gap-om-10">
              <label className={labelClass}>
                {t('dcim.cabling.provider')}
                <TextInput
                  required
                  value={circuitForm.provider}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, provider: e.target.value }); }}
                />
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.circuitId')}
                <TextInput
                  required
                  value={circuitForm.circuitId}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, circuitId: e.target.value }); }}
                />
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.kind')}
                <Select
                  value={circuitForm.kind}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, kind: e.target.value as CircuitKind }); }}
                >
                  {CIRCUIT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(('dcim.cabling.circuitKind.' + k) as MessageKey)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.status')}
                <Select
                  value={circuitForm.status}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, status: e.target.value as CircuitStatus }); }
                  }
                >
                  {CIRCUIT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(('dcim.cabling.circuitStatus.' + s) as MessageKey)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.bandwidthMbps')}
                <TextInput
                  type="number"
                  min={1}
                  value={circuitForm.bandwidthMbps}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, bandwidthMbps: e.target.value }); }}
                  className="w-28"
                />
              </label>
              <label className={labelClass}>
                {t('dcim.cabling.zEndDescription')}
                <TextInput
                  value={circuitForm.zEndDescription}
                  onChange={(e) => { setCircuitForm({ ...circuitForm, zEndDescription: e.target.value }); }}
                />
              </label>
            </div>
            <EndpointPicker
              legend={t('dcim.cabling.endA')}
              value={circuitForm.aEnd}
              onChange={(aEnd) => { setCircuitForm({ ...circuitForm, aEnd }); }}
              panels={data.patchPanels}
            />
            <div>
              <Button type="submit" disabled={circuit.isPending}>
                {t('dcim.cabling.circuitForm')}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
