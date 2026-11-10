'use client';
// REQ-IPAM-003 (ADR-055) — two-way DNS sync on the IPAM DNS tab:
// - the zones kept in sync with their server, site, last transfer and push, pending changes and last error; an
//   administrator adds one (server, port, TSIG key name, the credential set holding the secret, the site whose Node
//   reaches the server);
// - an operator requests a record to add or delete; the scheduler pushes it with the zone's next job and the transfer
//   that follows settles it;
// - the changes, newest first, with their state, refreshed while any is on its way.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DNS_SYNC, ROLES } from '@openmap/constants';
import { DNS_CHANGE_OPS, DNS_RECORD_TYPES, type DnsChangeOp, type DnsChangeState, type DnsRecordType } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { Button, Select, TextInput, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { dnsSyncKey, dnsSyncQuery, requestDnsChange, saveDnsZoneSync } from '@/lib/dns-sync-queries';
import { onboardingQuery } from '@/lib/setup-queries';
import { useFormatters, useT } from '@/providers';

const STATE_KEY = {
  pending: 'ipam.dnsSync.state.pending',
  sent: 'ipam.dnsSync.state.sent',
  applied: 'ipam.dnsSync.state.applied',
  failed: 'ipam.dnsSync.state.failed',
} as const satisfies Record<DnsChangeState, MessageKey>;
const STATE_TONE = { pending: 'unknown', sent: 'degraded', applied: 'healthy', failed: 'down' } as const satisfies Record<DnsChangeState, 'healthy' | 'degraded' | 'down' | 'unknown'>;
const OP_KEY = { add: 'ipam.dnsSync.op.add', delete: 'ipam.dnsSync.op.delete' } as const satisfies Record<DnsChangeOp, MessageKey>;

const labelClass = 'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';

export function DnsSyncPanel(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const queryClient = useQueryClient();
  const sync = useQuery(dnsSyncQuery(DNS_SYNC.screenRefreshMs));
  const setup = useQuery(onboardingQuery());
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: dnsSyncKey });
  };
  const [zoneForm, setZoneForm] = useState({ zone: '', server: '', port: '', tsigKeyName: '', credentialRef: '', siteId: '' });
  const [change, setChange] = useState({ zone: '', op: 'add' as DnsChangeOp, name: '', recordType: 'A' as DnsRecordType, value: '', ttl: '' });
  const saveZone = useMutation({
    mutationFn: () =>
      saveDnsZoneSync({
        zone: zoneForm.zone,
        server: zoneForm.server,
        port: zoneForm.port === '' ? null : Number(zoneForm.port),
        tsigKeyName: zoneForm.tsigKeyName === '' ? null : zoneForm.tsigKeyName,
        credentialRef: zoneForm.credentialRef === '' ? null : zoneForm.credentialRef,
        siteId: zoneForm.siteId,
      }),
    onSuccess: refresh,
  });
  const request = useMutation({
    mutationFn: () => requestDnsChange({ zone: change.zone, op: change.op, name: change.name, recordType: change.recordType, value: change.value, ttl: change.ttl === '' ? null : Number(change.ttl) }),
    onSuccess: () => {
      setChange((c) => ({ ...c, name: '', value: '' }));
      refresh();
    },
  });
  const sites = setup.data?.sites ?? [];
  const credentials = setup.data?.credentials ?? [];
  const siteName = (id: string): string => sites.find((s) => s.id === id)?.code ?? id;

  const submitZone = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    saveZone.mutate();
  };
  const submitChange = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    request.mutate();
  };

  return (
    <section aria-label={t('ipam.dnsSync.title')}>
      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('ipam.dnsSync.description')}>
          {t('ipam.dnsSync.title')}
        </SectionTitle>
        {sync.isPending ? (
          <QueryState status="pending" />
        ) : sync.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void sync.refetch();
            }}
          />
        ) : (
          <>
            {sync.data.dnsZoneSyncs.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('ipam.dnsSync.noZones')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('ipam.dnsSync.zones')}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.zone')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.server')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.site')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.lastPull')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.lastPush')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.pending')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sync.data.dnsZoneSyncs.map((z) => (
                      <tr key={z.id}>
                        <td className={tdClass}>
                          <span dir="ltr" className="font-om-mono">{z.zone}</span>
                          {z.lastError !== null ? <span className="block text-om-2xs text-om-state-down">{z.lastError}</span> : null}
                        </td>
                        <td className={tdClass}>
                          <span dir="ltr" className="font-om-mono">{z.server + ':' + String(z.port)}</span>
                          {z.tsigKeyName !== null ? <span className="block text-om-2xs text-om-muted">{t('ipam.dnsSync.key', { key: z.tsigKeyName })}</span> : null}
                        </td>
                        <td className={tdClass}>{siteName(z.siteId)}</td>
                        <td className={tdClass}>{z.lastPullAt === null ? t('ipam.dnsSync.never') : format.dateTime(z.lastPullAt)}</td>
                        <td className={tdClass}>{z.lastPushAt === null ? t('ipam.dnsSync.never') : format.dateTime(z.lastPushAt)}</td>
                        <td className={tdClass}>{format.integer(z.pending)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {can(ROLES.admin) ? (
              <form aria-label={t('ipam.dnsSync.addZone')} onSubmit={submitZone} className="flex flex-wrap items-end gap-om-10">
                <label className={labelClass}>
                  {t('ipam.dnsSync.zone')}
                  <TextInput required value={zoneForm.zone} onChange={(e) => { setZoneForm({ ...zoneForm, zone: e.target.value }); }} />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.server')}
                  <TextInput required value={zoneForm.server} onChange={(e) => { setZoneForm({ ...zoneForm, server: e.target.value }); }} />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.port')}
                  <TextInput type="number" min={1} value={zoneForm.port} onChange={(e) => { setZoneForm({ ...zoneForm, port: e.target.value }); }} className="w-24" />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.tsigKey')}
                  <TextInput value={zoneForm.tsigKeyName} onChange={(e) => { setZoneForm({ ...zoneForm, tsigKeyName: e.target.value }); }} />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.credential')}
                  <Select value={zoneForm.credentialRef} onChange={(e) => { setZoneForm({ ...zoneForm, credentialRef: e.target.value }); }}>
                    <option value="">{t('ipam.dnsSync.noCredential')}</option>
                    {credentials.map((c) => (
                      <option key={c.ref} value={c.ref}>
                        {c.ref}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.site')}
                  <Select required value={zoneForm.siteId} onChange={(e) => { setZoneForm({ ...zoneForm, siteId: e.target.value }); }}>
                    <option value="">{t('ipam.dnsSync.chooseSite')}</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code + ' · ' + s.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button type="submit" disabled={saveZone.isPending}>
                  {t('ipam.dnsSync.addZone')}
                </Button>
              </form>
            ) : null}

            {can(ROLES.operator) && sync.data.dnsZoneSyncs.length > 0 ? (
              <form aria-label={t('ipam.dnsSync.request')} onSubmit={submitChange} className="flex flex-wrap items-end gap-om-10">
                <label className={labelClass}>
                  {t('ipam.dnsSync.zone')}
                  <Select required value={change.zone} onChange={(e) => { setChange({ ...change, zone: e.target.value }); }}>
                    <option value="">{t('ipam.dnsSync.chooseZone')}</option>
                    {sync.data.dnsZoneSyncs.map((z) => (
                      <option key={z.id} value={z.zone}>
                        {z.zone}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.opLabel')}
                  <Select value={change.op} onChange={(e) => { setChange({ ...change, op: e.target.value as DnsChangeOp }); }}>
                    {DNS_CHANGE_OPS.map((op) => (
                      <option key={op} value={op}>
                        {t(OP_KEY[op])}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.name')}
                  <TextInput required value={change.name} onChange={(e) => { setChange({ ...change, name: e.target.value }); }} />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.type')}
                  <Select value={change.recordType} onChange={(e) => { setChange({ ...change, recordType: e.target.value as DnsRecordType }); }}>
                    {DNS_RECORD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.value')}
                  <TextInput required value={change.value} onChange={(e) => { setChange({ ...change, value: e.target.value }); }} />
                </label>
                <label className={labelClass}>
                  {t('ipam.dnsSync.ttl')}
                  <TextInput type="number" min={1} value={change.ttl} onChange={(e) => { setChange({ ...change, ttl: e.target.value }); }} className="w-24" />
                </label>
                <Button type="submit" disabled={request.isPending}>
                  {t('ipam.dnsSync.request')}
                </Button>
              </form>
            ) : null}
            {saveZone.isError || request.isError ? (
              <p role="alert" className="text-om-xs text-om-state-down">
                {(saveZone.error ?? request.error)?.message ?? t('common.error')}
              </p>
            ) : null}

            {sync.data.dnsChanges.length === 0 ? null : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('ipam.dnsSync.changes')}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.record')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.opLabel')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.stateLabel')}</th>
                      <th scope="col" className={thClass}>{t('ipam.dnsSync.requested')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sync.data.dnsChanges.map((c) => (
                      <tr key={c.id}>
                        <td className={tdClass}>
                          <span dir="ltr" className="font-om-mono">{c.name + ' ' + c.recordType + ' ' + c.value}</span>
                        </td>
                        <td className={tdClass}>{t(OP_KEY[c.op])}</td>
                        <td className={tdClass}>
                          <Tag variant="state" state={STATE_TONE[c.state]}>
                            {t(STATE_KEY[c.state])}
                          </Tag>
                          {c.error !== null ? <span className="block text-om-2xs text-om-state-down">{c.error}</span> : null}
                        </td>
                        <td className={tdClass}>
                          {format.dateTime(c.requestedAt)}
                          <span className="block text-om-2xs text-om-muted">{c.requestedBy}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

