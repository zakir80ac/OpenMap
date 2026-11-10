'use client';
// REQ-IPAM-004 (ADR-063) — the IPAM "Switch ports" tab:
// - choose a switch (search among network devices) and see its ports: state, speed, VLAN, description, the neighbour on
//   the far end, the MACs each port learned with their IP and owner, and how long a down port has not been up; ports
//   free to reuse are marked;
// - choose a port to see its history: every change of state, speed, description, VLAN and learned MACs, newest first;
// - find a MAC address: the switch port that learned it, the ARP record that carries it and the CI that owns it.
import { useQuery } from '@tanstack/react-query';
import { CONSOLE, SWITCH_PORTS } from '@openmap/constants';
import { normaliseMac, type PortState } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
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
import { localizedHref } from '@/lib/locale-path';
import { searchQuery } from '@/lib/queries';
import {
  macLookupQuery,
  portHistoryQuery,
  switchPortsQuery,
  type PortChange,
  type SwitchPort,
} from '@/lib/switch-ports-queries';
import { useDebounced } from '@/lib/use-debounced';
import { useFormatters, useT, type Translate } from '@/providers';

/** The layers a switch is found in: network devices sit in network and security. */
const SWITCH_LAYERS = ['network_security'] as const;

export function stateKey(state: PortState): MessageKey {
  return `ipam.ports.state.${state}`;
}

/** A history change worded for the table: the key's label and its before and after values. */
export function changeKey(key: string): MessageKey {
  const k = 'ipam.ports.history.key.' + key;
  return (
    ['state', 'speedMbps', 'alias', 'pvid', 'learnedMacs'].includes(key) ? k : 'ipam.ports.history.key.other'
  ) as MessageKey;
}

/** What a learned MAC is: its IP and owner when known. */
export function macLabel(t: Translate, m: SwitchPort['learnedMacs'][number]): string {
  if (m.owner !== null && m.ip !== null)
    return t('ipam.ports.macOwnerIp', { mac: m.mac, owner: m.owner.displayName, ip: m.ip });
  if (m.owner !== null) return t('ipam.ports.macOwner', { mac: m.mac, owner: m.owner.displayName });
  if (m.ip !== null) return t('ipam.ports.macIp', { mac: m.mac, ip: m.ip });
  return m.mac;
}

function changeValue(t: Translate, c: PortChange, value: string | null): string {
  if (value === null) return t('ipam.ports.history.none');
  return c.key === 'state' && ['up', 'down', 'admin_down', 'unknown'].includes(value)
    ? t(stateKey(value as PortState))
    : value;
}

function PortHistoryCard({ port, onClose }: { port: SwitchPort; onClose: () => void }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const history = useQuery(portHistoryQuery(port.port.id));
  return (
    <Card padding="16" className="flex flex-col gap-om-10">
      <div className="flex flex-col gap-om-10" data-testid="port-history">
        <SectionTitle
          as="h3"
          size="sm"
          description={
            history.data === undefined
              ? undefined
              : t('ipam.ports.history.subtitle', {
                  days: format.integer(history.data.days),
                  versions: format.integer(history.data.versions),
                })
          }
          action={
            <Button tone="quiet" onClick={onClose}>
              {t('common.close')}
            </Button>
          }
        >
          {t('ipam.ports.history.title', { port: port.name })}
        </SectionTitle>
        {history.isPending ? <QueryState status="pending" /> : null}
        {history.isError ? <QueryState status="error" /> : null}
        {history.data !== undefined ? (
          history.data.changes.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('ipam.ports.history.empty')}</p>
          ) : (
            <table className={tableClass} aria-label={t('ipam.ports.history.title', { port: port.name })}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>{t('ipam.ports.history.at')}</th>
                  <th className={thClass}>{t('ipam.ports.history.what')}</th>
                  <th className={thClass}>{t('ipam.ports.history.from')}</th>
                  <th className={thClass}>{t('ipam.ports.history.to')}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.changes.map((c, i) => (
                  <tr key={c.at + c.key + String(i)} className={rowClass}>
                    <td className={tdClass}>{format.dateTime(c.at)}</td>
                    <td className={tdClass}>{t(changeKey(c.key))}</td>
                    <td className={tdClass + ' font-om-mono text-om-secondary'}>
                      {changeValue(t, c, c.from)}
                    </td>
                    <td className={tdClass + ' font-om-mono text-om-primary'}>{changeValue(t, c, c.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </Card>
  );
}

function MacLookupCard({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [mac, setMac] = useState<string | null>(null);
  const lookup = useQuery(macLookupQuery(mac));
  const invalid = text.trim() !== '' && normaliseMac(text) === null;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const m = normaliseMac(text);
    if (m !== null) setMac(m);
  };
  return (
    <Card padding="16" className="flex flex-col gap-om-10">
      <div className="flex flex-col gap-om-10" data-testid="mac-lookup">
        <SectionTitle as="h2" size="sm" description={t('ipam.ports.mac.subtitle')}>
          {t('ipam.ports.mac.title')}
        </SectionTitle>
        <form
          className="flex flex-wrap items-end gap-om-10"
          aria-label={t('ipam.ports.mac.title')}
          onSubmit={onSubmit}
        >
          <Field
            id={id + '-mac'}
            label={t('ipam.ports.mac.label')}
            hint={invalid ? t('ipam.ports.mac.invalid') : undefined}
          >
            <TextInput
              id={id + '-mac'}
              value={text}
              maxLength={SWITCH_PORTS.macTextMaxLength}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={normaliseMac(text) === null}>
            {t('ipam.ports.mac.find')}
          </Button>
        </form>
        {lookup.isPending && mac !== null ? <QueryState status="pending" /> : null}
        {lookup.isError ? <QueryState status="error" /> : null}
        {lookup.data !== undefined ? (
          lookup.data.sightings.length === 0 ? (
            <p role="status" className="text-om-sm text-om-secondary">
              {t('ipam.ports.mac.none', { mac: lookup.data.mac })}
            </p>
          ) : (
            <ul
              aria-live="polite"
              className="flex flex-col gap-om-6 text-om-sm"
              aria-label={t('ipam.ports.mac.results', { mac: lookup.data.mac })}
            >
              {lookup.data.sightings.map((s, i) => (
                <li key={s.kind + s.ci.id + String(i)} className="flex flex-wrap items-center gap-om-6">
                  <Tag>{t(`ipam.ports.mac.kind.${s.kind}`)}</Tag>
                  <Link
                    href={localizedHref(locale, '/cmdb/' + encodeURIComponent(s.ci.id))}
                    className="text-om-primary hover:text-om-cyan"
                  >
                    {s.ci.displayName}
                  </Link>
                  {s.port !== null ? <span className="font-om-mono text-om-secondary">{s.port}</span> : null}
                  {s.ip !== null ? <span className="font-om-mono text-om-secondary">{s.ip}</span> : null}
                  <span className="text-om-2xs text-om-muted">
                    {t('ipam.ports.mac.seen', { at: format.dateTime(s.seenAt) })}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </Card>
  );
}

export function SwitchPortsView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);
  const hits = useQuery(
    searchQuery({ text: debounced, layers: [...SWITCH_LAYERS], first: SWITCH_PORTS.switchSearchLimit }),
  );
  const switches = useMemo(
    () =>
      (hits.data ?? []).filter(
        (h) => h.ci.type === 'network_device' || h.ci.type === 'load_balancer' || h.ci.type === 'fc_switch',
      ),
    [hits.data],
  );
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const ports = useQuery(switchPortsQuery(deviceId));
  const [portId, setPortId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const data = ports.data;
  const shown = data === undefined ? [] : all ? data.ports : data.ports.slice(0, SWITCH_PORTS.portRows);
  const selected = data?.ports.find((p) => p.port.id === portId) ?? null;

  return (
    <div className="flex flex-col gap-om-16" data-testid="switch-ports">
      <Card padding="16" className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-search'} label={t('ipam.ports.search')}>
          <TextInput
            id={id + '-search'}
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </Field>
        <Field id={id + '-device'} label={t('ipam.ports.device')}>
          <Select
            id={id + '-device'}
            value={deviceId ?? ''}
            onChange={(e) => {
              setDeviceId(e.target.value === '' ? null : e.target.value);
              setPortId(null);
              setAll(false);
            }}
          >
            <option value="">{t('ipam.ports.choose')}</option>
            {switches.map((h) => (
              <option key={h.ci.id} value={h.ci.id}>
                {h.ci.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <MacLookupCard locale={locale} />

      {deviceId === null ? <p className="text-om-sm text-om-secondary">{t('ipam.ports.pick')}</p> : null}
      {ports.isPending && deviceId !== null ? <QueryState status="pending" /> : null}
      {ports.isError ? <QueryState status="error" /> : null}
      {data !== undefined ? (
        <>
          <div
            className="grid grid-cols-2 gap-om-12 md:grid-cols-6"
            role="group"
            aria-label={t('ipam.ports.summary', { device: data.device.displayName })}
          >
            <Kpi label={t('ipam.ports.kpi.ports')} value={format.integer(data.summary.ports)} />
            <Kpi label={t('ipam.ports.state.up')} value={format.integer(data.summary.up)} />
            <Kpi label={t('ipam.ports.state.down')} value={format.integer(data.summary.down)} />
            <Kpi label={t('ipam.ports.state.admin_down')} value={format.integer(data.summary.adminDown)} />
            <Kpi
              label={t('ipam.ports.kpi.unused', { days: format.integer(SWITCH_PORTS.unusedDays) })}
              value={format.integer(data.summary.unused)}
            />
            <Kpi label={t('ipam.ports.kpi.macs')} value={format.integer(data.summary.learnedMacs)} />
          </div>
          {selected !== null ? (
            <PortHistoryCard
              port={selected}
              onClose={() => {
                setPortId(null);
              }}
            />
          ) : null}
          <Card padding="16" className="flex flex-col gap-om-10">
            <SectionTitle as="h2" size="sm" description={t('ipam.ports.table.subtitle')}>
              {t('ipam.ports.table.title', { device: data.device.displayName })}
            </SectionTitle>
            {data.ports.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('ipam.ports.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className={tableClass}
                  aria-label={t('ipam.ports.table.title', { device: data.device.displayName })}
                >
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>{t('ipam.ports.col.port')}</th>
                      <th className={thClass}>{t('ipam.ports.col.state')}</th>
                      <th className={thClass}>{t('ipam.ports.col.speed')}</th>
                      <th className={thClass}>{t('ipam.ports.col.vlan')}</th>
                      <th className={thClass}>{t('ipam.ports.col.alias')}</th>
                      <th className={thClass}>{t('ipam.ports.col.neighbour')}</th>
                      <th className={thClass}>{t('ipam.ports.col.macs')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.port.id} className={rowClass} data-state={p.state}>
                        <td className={tdClass}>
                          <Button
                            tone="quiet"
                            aria-label={t('ipam.ports.history.open', { port: p.name })}
                            onClick={() => {
                              setPortId(p.port.id);
                            }}
                          >
                            {p.name}
                          </Button>
                        </td>
                        <td className={tdClass}>
                          <span className="flex flex-wrap gap-om-4">
                            <Tag>{t(stateKey(p.state))}</Tag>
                            {p.unused ? (
                              <Tag>{t('ipam.ports.unused', { days: format.integer(p.daysNotUp ?? 0) })}</Tag>
                            ) : null}
                          </span>
                        </td>
                        <td className={tdClass + ' font-om-mono'}>
                          {p.speedMbps === null
                            ? ''
                            : t('ipam.ports.speed', { mbps: format.integer(p.speedMbps) })}
                        </td>
                        <td className={tdClass + ' font-om-mono'}>
                          {p.vlan === null ? '' : format.integer(p.vlan)}
                        </td>
                        <td className={tdClass + ' text-om-secondary'}>{p.alias ?? ''}</td>
                        <td className={tdClass}>
                          {p.neighbour === null ? null : (
                            <Link
                              href={localizedHref(locale, '/cmdb/' + encodeURIComponent(p.neighbour.ci.id))}
                              className="text-om-primary hover:text-om-cyan"
                            >
                              {p.neighbour.port === null
                                ? p.neighbour.ci.displayName
                                : t('ipam.ports.neighbourPort', {
                                    ci: p.neighbour.ci.displayName,
                                    port: p.neighbour.port,
                                  })}
                            </Link>
                          )}
                        </td>
                        <td className={tdClass + ' font-om-mono text-om-secondary'}>
                          {p.learnedMacs.length === 0 ? null : (
                            <span className="flex flex-col gap-om-2">
                              <span>
                                {macLabel(t, p.learnedMacs[0] ?? { mac: '', ip: null, owner: null })}
                              </span>
                              {p.learnedMacCount > 1 ? (
                                <span className="text-om-2xs text-om-muted">
                                  {t('ipam.ports.moreMacs', { count: format.integer(p.learnedMacCount - 1) })}
                                </span>
                              ) : null}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.ports.length > shown.length ? (
              <div>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setAll(true);
                  }}
                >
                  {t('ipam.ports.showAll', { count: format.integer(data.ports.length) })}
                </Button>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
