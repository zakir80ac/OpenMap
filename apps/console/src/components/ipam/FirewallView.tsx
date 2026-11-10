'use client';
// REQ-IPAM-005 (ADR-064) — the IPAM "Firewall" tab:
// - choose a device with firewall rules (a firewall appliance, or a host whose nftables rule set discovery read) and see
//   its rules in evaluation order: zones or interfaces, source, destination, service, action, hits, and the findings
//   (shadowed by an earlier rule, never hit, any-service allow); its chains with their policies; its policy objects
//   with how many rules use each and the ones no rule names;
// - check a connection: source, destination, protocol and port (and zones when the firewalls are zone-based), across
//   every firewall or the chosen one; each answers allow, deny, reject or no match with the rule that decides, and
//   names the rules it could not tell from what was given.
// Addresses, services, chains and members are isolated (<bdi>) so they keep their order in Arabic.
import { useQuery } from '@tanstack/react-query';
import { CONSOLE, FIREWALL } from '@openmap/constants';
import { parseIp, type FirewallAction, type FirewallVerdict } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Tag, type UiState } from '@openmap/ui';
import Link from 'next/link';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
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
import {
  firewallCheckQuery,
  firewallDevicesQuery,
  firewallPolicyQuery,
  type FirewallCheckInput,
  type FirewallFinding,
  type FirewallPolicy,
  type FirewallRule,
} from '@/lib/firewall-queries';
import { localizedHref } from '@/lib/locale-path';
import { useDebounced } from '@/lib/use-debounced';
import { useFormatters, useT, type Translate } from '@/providers';

const PROTOCOLS = ['tcp', 'udp', 'icmp', 'any'] as const;
type Protocol = (typeof PROTOCOLS)[number];
const PORTLESS: readonly Protocol[] = ['icmp', 'any'];
type Show = 'all' | 'findings';

export function actionKey(action: FirewallAction): MessageKey {
  return `ipam.fw.action.${action}`;
}

export function verdictState(verdict: FirewallVerdict): UiState {
  if (verdict === 'allow') return 'healthy';
  if (verdict === 'no_match') return 'unknown';
  return 'down';
}

function actionState(action: FirewallAction): UiState {
  if (action === 'allow') return 'healthy';
  if (action === 'deny' || action === 'reject') return 'down';
  return 'unknown';
}

export function findingLabel(t: Translate, f: FirewallFinding): string {
  if (f.kind === 'shadowed') {
    const rule = f.byName ?? f.byRuleId ?? '';
    return f.sameAction === false
      ? t('ipam.fw.finding.conflict', { rule })
      : t('ipam.fw.finding.redundant', { rule });
  }
  return f.kind === 'unused' ? t('ipam.fw.finding.unused') : t('ipam.fw.finding.permissive');
}

function findingState(f: FirewallFinding): UiState {
  if (f.kind === 'permissive') return 'at_risk';
  if (f.kind === 'shadowed') return f.sameAction === false ? 'down' : 'degraded';
  return 'unknown';
}

/** A list of addresses or services as the table prints it; an empty list means any. */
export function specText(t: Translate, specs: readonly string[]): string {
  return specs.length === 0 ? t('ipam.fw.any') : specs.join(', ');
}

export function chainLabel(t: Translate, chain: string): string {
  return chain === '' ? t('ipam.fw.chain.single') : chain;
}

function scopeText(t: Translate, r: FirewallRule): string | null {
  if (r.fromZone !== null || r.toZone !== null)
    return t('ipam.fw.zones', { from: r.fromZone ?? t('ipam.fw.any'), to: r.toZone ?? t('ipam.fw.any') });
  if (r.inInterface !== null) return t('ipam.fw.iface.in', { name: r.inInterface });
  if (r.outInterface !== null) return t('ipam.fw.iface.out', { name: r.outInterface });
  return null;
}

function TrafficCheck({
  locale,
  deviceId,
  deviceName,
}: {
  locale: Locale;
  deviceId: string | null;
  deviceName: string | null;
}): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('tcp');
  const [port, setPort] = useState('');
  const [fromZone, setFromZone] = useState('');
  const [toZone, setToZone] = useState('');
  const [onlyDevice, setOnlyDevice] = useState(false);
  const [input, setInput] = useState<FirewallCheckInput | null>(null);
  const check = useQuery(firewallCheckQuery(input));
  const portless = PORTLESS.includes(protocol);
  const portNumber = port.trim() === '' ? null : Number(port);
  const portValid =
    portless ||
    portNumber === null ||
    (Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= FIREWALL.maxPort);
  const sourceValid = parseIp(source) !== null;
  const destinationValid = parseIp(destination) !== null;
  const ready = sourceValid && destinationValid && portValid;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    setInput({
      source: source.trim(),
      destination: destination.trim(),
      protocol,
      port: portless ? null : portNumber,
      deviceId: onlyDevice && deviceId !== null ? deviceId : null,
      fromZone: fromZone.trim() === '' ? null : fromZone.trim(),
      toZone: toZone.trim() === '' ? null : toZone.trim(),
    });
  };
  const invalid = (text: string, valid: boolean): string | undefined =>
    text.trim() !== '' && !valid ? t('ipam.fw.check.invalidAddress') : undefined;
  return (
    <Card padding="16" className="flex flex-col gap-om-10">
      <SectionTitle as="h2" size="sm" description={t('ipam.fw.check.subtitle')}>
        {t('ipam.fw.check.title')}
      </SectionTitle>
      <form
        className="flex flex-wrap items-end gap-om-10"
        aria-label={t('ipam.fw.check.title')}
        onSubmit={onSubmit}
      >
        <Field id={id + '-src'} label={t('ipam.fw.check.source')} hint={invalid(source, sourceValid)}>
          <TextInput
            id={id + '-src'}
            value={source}
            maxLength={FIREWALL.checkTextMaxLength}
            onChange={(e) => {
              setSource(e.target.value);
            }}
          />
        </Field>
        <Field
          id={id + '-dst'}
          label={t('ipam.fw.check.destination')}
          hint={invalid(destination, destinationValid)}
        >
          <TextInput
            id={id + '-dst'}
            value={destination}
            maxLength={FIREWALL.checkTextMaxLength}
            onChange={(e) => {
              setDestination(e.target.value);
            }}
          />
        </Field>
        <Field id={id + '-proto'} label={t('ipam.fw.check.protocol')}>
          <Select
            id={id + '-proto'}
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value as Protocol);
            }}
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {t(`ipam.fw.protocol.${p}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id={id + '-port'}
          label={t('ipam.fw.check.port')}
          hint={portValid ? undefined : t('ipam.fw.check.invalidPort')}
        >
          <TextInput
            id={id + '-port'}
            inputMode="numeric"
            value={portless ? '' : port}
            disabled={portless}
            onChange={(e) => {
              setPort(e.target.value);
            }}
          />
        </Field>
        <Field id={id + '-from'} label={t('ipam.fw.check.fromZone')}>
          <TextInput
            id={id + '-from'}
            value={fromZone}
            maxLength={FIREWALL.checkTextMaxLength}
            onChange={(e) => {
              setFromZone(e.target.value);
            }}
          />
        </Field>
        <Field id={id + '-to'} label={t('ipam.fw.check.toZone')}>
          <TextInput
            id={id + '-to'}
            value={toZone}
            maxLength={FIREWALL.checkTextMaxLength}
            onChange={(e) => {
              setToZone(e.target.value);
            }}
          />
        </Field>
        {deviceId !== null && deviceName !== null ? (
          <label className="flex items-center gap-om-6 text-om-sm text-om-secondary">
            <input
              type="checkbox"
              checked={onlyDevice}
              onChange={(e) => {
                setOnlyDevice(e.target.checked);
              }}
            />
            {t('ipam.fw.check.only', { device: deviceName })}
          </label>
        ) : null}
        <Button type="submit" disabled={!ready}>
          {t('ipam.fw.check.run')}
        </Button>
      </form>
      {check.isPending && input !== null ? <QueryState status="pending" /> : null}
      {check.isError ? <QueryState status="error" /> : null}
      {check.data !== undefined ? (
        check.data.results.length === 0 ? (
          <p role="status" className="text-om-sm text-om-secondary">
            {t('ipam.fw.check.none')}
          </p>
        ) : (
          <div className="flex flex-col gap-om-6">
            <p className="text-om-2xs text-om-muted">
              {t(check.data.truncated ? 'ipam.fw.check.truncated' : 'ipam.fw.check.evaluated', {
                count: format.integer(check.data.evaluated),
              })}
            </p>
            <ul
              aria-live="polite"
              aria-label={t('ipam.fw.check.results')}
              className="flex flex-col gap-om-6 text-om-sm"
            >
              {check.data.results.map((r) => (
                <li
                  key={r.device.id + '|' + r.chain}
                  className="flex flex-wrap items-center gap-om-6"
                  data-verdict={r.verdict}
                >
                  <Tag variant="state" state={verdictState(r.verdict)}>
                    {t(`ipam.fw.verdict.${r.verdict}`)}
                  </Tag>
                  <Link
                    href={localizedHref(locale, '/cmdb/' + encodeURIComponent(r.device.id))}
                    className="text-om-primary hover:text-om-cyan"
                  >
                    {r.device.displayName}
                  </Link>
                  <span className="font-om-mono text-om-2xs text-om-muted">
                    <bdi>{chainLabel(t, r.chain)}</bdi>
                  </span>
                  <span className="text-om-secondary">
                    {r.rule === null
                      ? t('ipam.fw.check.noRule')
                      : t('ipam.fw.check.byRule', {
                          rule: r.rule.name,
                          position: format.integer(r.rule.position),
                        })}
                  </span>
                  {r.uncertain.length > 0 ? (
                    <span className="text-om-2xs text-om-muted">
                      {t('ipam.fw.check.uncertain', {
                        count: format.integer(r.uncertain.length),
                        rules: r.uncertain.map((u) => u.name).join(', '),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </Card>
  );
}

function RulesTable({ policy, show }: { policy: FirewallPolicy; show: Show }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [all, setAll] = useState(false);
  const multiChain = policy.chains.some((c) => c.name !== '');
  const filtered = show === 'findings' ? policy.rules.filter((r) => r.findings.length > 0) : policy.rules;
  const shown = all ? filtered : filtered.slice(0, FIREWALL.ruleRows);
  const title = t('ipam.fw.rules.title', { device: policy.device.displayName });
  if (filtered.length === 0)
    return (
      <p className="text-om-sm text-om-secondary">
        {t(show === 'findings' ? 'ipam.fw.rules.noFindings' : 'ipam.fw.rules.empty')}
      </p>
    );
  return (
    <>
      <div className="overflow-x-auto">
        <table className={tableClass} aria-label={title}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>{t('ipam.fw.col.position')}</th>
              <th className={thClass}>{t('ipam.fw.col.name')}</th>
              {multiChain ? <th className={thClass}>{t('ipam.fw.col.chain')}</th> : null}
              <th className={thClass}>{t('ipam.fw.col.scope')}</th>
              <th className={thClass}>{t('ipam.fw.col.source')}</th>
              <th className={thClass}>{t('ipam.fw.col.destination')}</th>
              <th className={thClass}>{t('ipam.fw.col.service')}</th>
              <th className={thClass}>{t('ipam.fw.col.action')}</th>
              <th className={thClass}>{t('ipam.fw.col.hits')}</th>
              <th className={thClass}>{t('ipam.fw.col.findings')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.rule.id}
                className={rowClass}
                data-action={r.action}
                data-findings={r.findings.map((f) => f.kind).join(' ')}
              >
                <td className={tdClass + ' font-om-mono'}>{format.integer(r.position)}</td>
                <td className={tdClass}>
                  <span className="flex flex-col">
                    <span className="text-om-primary">{r.name}</span>
                    {r.isPolicy ? (
                      <span className="text-om-2xs text-om-muted">{t('ipam.fw.policyRule')}</span>
                    ) : null}
                    {!r.enabled ? (
                      <span className="text-om-2xs text-om-muted">{t('ipam.fw.disabled')}</span>
                    ) : null}
                  </span>
                </td>
                {multiChain ? (
                  <td className={tdClass + ' font-om-mono text-om-2xs text-om-secondary'}>
                    <bdi>{chainLabel(t, r.chain)}</bdi>
                  </td>
                ) : null}
                <td className={tdClass + ' text-om-secondary'}>{scopeText(t, r) ?? ''}</td>
                <td className={tdClass + ' font-om-mono'}>
                  <bdi>{specText(t, r.sources)}</bdi>
                  {r.conditions.length > 0 ? (
                    <span className="block text-om-2xs text-om-muted">
                      <bdi>{r.conditions.join('; ')}</bdi>
                    </span>
                  ) : null}
                </td>
                <td className={tdClass + ' font-om-mono'}>
                  <bdi>{specText(t, r.destinations)}</bdi>
                </td>
                <td className={tdClass + ' font-om-mono'}>
                  <bdi>{specText(t, r.services)}</bdi>
                </td>
                <td className={tdClass}>
                  <span className="flex flex-col gap-om-4">
                    <Tag variant="state" state={actionState(r.action)}>
                      {t(actionKey(r.action))}
                    </Tag>
                    {r.target !== null ? (
                      <span className="font-om-mono text-om-2xs text-om-muted">
                        <bdi>{t('ipam.fw.target', { target: r.target })}</bdi>
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={tdClass + ' font-om-mono'}>
                  {r.hitCount === null ? '' : format.integer(r.hitCount)}
                </td>
                <td className={tdClass}>
                  <span className="flex flex-wrap gap-om-4">
                    {r.findings.map((f) => (
                      <Tag key={f.kind} variant="state" state={findingState(f)}>
                        {findingLabel(t, f)}
                      </Tag>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && filtered.length > shown.length ? (
        <Button
          tone="quiet"
          onClick={() => {
            setAll(true);
          }}
        >
          {t('ipam.fw.rules.showAll', { count: format.integer(filtered.length) })}
        </Button>
      ) : null}
    </>
  );
}

function PolicySection({ policy }: { policy: FirewallPolicy }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [show, setShow] = useState<Show>('all');
  const s = policy.summary;
  const multiChain = policy.chains.some((c) => c.name !== '');
  return (
    <>
      <div
        className="grid grid-cols-2 gap-om-12 md:grid-cols-7"
        role="group"
        aria-label={t('ipam.fw.summary', { device: policy.device.displayName })}
      >
        <Kpi label={t('ipam.fw.kpi.rules')} value={format.integer(s.rules)} />
        <Kpi label={t('ipam.fw.kpi.allow')} value={format.integer(s.allow)} />
        <Kpi label={t('ipam.fw.kpi.deny')} value={format.integer(s.deny)} />
        <Kpi label={t('ipam.fw.kpi.shadowed')} value={format.integer(s.shadowed)} />
        <Kpi label={t('ipam.fw.kpi.unused')} value={format.integer(s.unused)} />
        <Kpi label={t('ipam.fw.kpi.permissive')} value={format.integer(s.permissive)} />
        <Kpi label={t('ipam.fw.kpi.unusedObjects')} value={format.integer(s.unusedObjects)} />
      </div>
      {multiChain ? (
        <Card padding="16" className="flex flex-col gap-om-10">
          <SectionTitle as="h2" size="sm" description={t('ipam.fw.chains.subtitle')}>
            {t('ipam.fw.chains.title')}
          </SectionTitle>
          <table className={tableClass} aria-label={t('ipam.fw.chains.title')}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>{t('ipam.fw.col.chain')}</th>
                <th className={thClass}>{t('ipam.fw.col.hook')}</th>
                <th className={thClass}>{t('ipam.fw.col.rules')}</th>
                <th className={thClass}>{t('ipam.fw.col.policy')}</th>
              </tr>
            </thead>
            <tbody>
              {policy.chains.map((c) => (
                <tr key={c.name} className={rowClass}>
                  <td className={tdClass + ' font-om-mono'}>
                    <bdi>{chainLabel(t, c.name)}</bdi>
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>{c.hook ?? t('ipam.fw.chain.called')}</td>
                  <td className={tdClass + ' font-om-mono'}>{format.integer(c.rules)}</td>
                  <td className={tdClass}>
                    {c.policy === null ? (
                      ''
                    ) : (
                      <Tag variant="state" state={actionState(c.policy)}>
                        {t(actionKey(c.policy))}
                      </Tag>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Card padding="16" className="flex flex-col gap-om-10">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('ipam.fw.rules.subtitle')}
          action={
            <Field id={id + '-show'} label={t('ipam.fw.rules.show')}>
              <Select
                id={id + '-show'}
                value={show}
                onChange={(e) => {
                  setShow(e.target.value as Show);
                }}
              >
                <option value="all">{t('ipam.fw.rules.showEvery')}</option>
                <option value="findings">{t('ipam.fw.rules.showFindings')}</option>
              </Select>
            </Field>
          }
        >
          {t('ipam.fw.rules.title', { device: policy.device.displayName })}
        </SectionTitle>
        {policy.truncated ? (
          <p className="text-om-2xs text-om-muted">
            {t('ipam.fw.rules.truncated', { count: format.integer(FIREWALL.analysisRuleLimit) })}
          </p>
        ) : null}
        <RulesTable policy={policy} show={show} />
      </Card>
      <Card padding="16" className="flex flex-col gap-om-10">
        <SectionTitle as="h2" size="sm" description={t('ipam.fw.objects.subtitle')}>
          {t('ipam.fw.objects.title')}
        </SectionTitle>
        {policy.objects.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('ipam.fw.objects.empty')}</p>
        ) : (
          <table className={tableClass} aria-label={t('ipam.fw.objects.title')}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>{t('ipam.fw.col.name')}</th>
                <th className={thClass}>{t('ipam.fw.col.kind')}</th>
                <th className={thClass}>{t('ipam.fw.col.elements')}</th>
                <th className={thClass}>{t('ipam.fw.col.rules')}</th>
              </tr>
            </thead>
            <tbody>
              {policy.objects.map((o) => (
                <tr key={o.object.id} className={rowClass} data-unused={o.unused ? 'true' : 'false'}>
                  <td className={tdClass}>
                    <span className="flex flex-col">
                      <span className="font-om-mono text-om-primary">{o.name}</span>
                      {o.comment !== null ? (
                        <span className="text-om-2xs text-om-muted">{o.comment}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className={tdClass}>{t(`ipam.fw.kind.${o.kind}`)}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>
                    <bdi>{o.elements.join(', ')}</bdi>
                  </td>
                  <td className={tdClass}>
                    {o.unused ? (
                      <Tag variant="state" state="degraded">
                        {t('ipam.fw.objects.unused')}
                      </Tag>
                    ) : (
                      <span className="font-om-mono">{format.integer(o.ruleCount)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

export function FirewallView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const debounced = useDebounced(text.trim(), CONSOLE.searchDebounceMs);
  const devices = useQuery(firewallDevicesQuery(debounced));
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const policy = useQuery(firewallPolicyQuery(deviceId));
  const chosen = devices.data?.find((d) => d.device.id === deviceId) ?? null;
  return (
    <div className="flex flex-col gap-om-16" data-testid="firewall">
      <Card padding="16" className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-search'} label={t('ipam.fw.search')}>
          <TextInput
            id={id + '-search'}
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </Field>
        <Field id={id + '-device'} label={t('ipam.fw.device')}>
          <Select
            id={id + '-device'}
            value={deviceId ?? ''}
            onChange={(e) => {
              setDeviceId(e.target.value === '' ? null : e.target.value);
            }}
          >
            <option value="">{t('ipam.fw.choose')}</option>
            {chosen === null && policy.data !== undefined ? (
              <option value={policy.data.device.id}>{policy.data.device.displayName}</option>
            ) : null}
            {(devices.data ?? []).map((d) => (
              <option key={d.device.id} value={d.device.id}>
                {t('ipam.fw.deviceOption', { device: d.device.displayName, rules: format.integer(d.rules) })}
              </option>
            ))}
          </Select>
        </Field>
        {devices.isError ? <QueryState status="error" /> : null}
      </Card>

      <TrafficCheck
        locale={locale}
        deviceId={deviceId}
        deviceName={policy.data?.device.displayName ?? chosen?.device.displayName ?? null}
      />

      {deviceId === null ? <p className="text-om-sm text-om-secondary">{t('ipam.fw.pick')}</p> : null}
      {policy.isPending && deviceId !== null ? <QueryState status="pending" /> : null}
      {policy.isError ? <QueryState status="error" /> : null}
      {policy.data !== undefined ? <PolicySection key={policy.data.device.id} policy={policy.data} /> : null}
    </div>
  );
}
