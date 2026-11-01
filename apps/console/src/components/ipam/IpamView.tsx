'use client';
// REQ-UI-010 REQ-IPAM-001 — IPAM: the subnet tree by CIDR containment with utilisation, the selected subnet's
// addresses and next free address, DNS zones and records, DHCP scopes and leases. Everything comes from the CIs the
// dns, dhcp and address collectors discovered; nothing is typed in here.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { IPAM } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Bar, Card, Kpi, Pill, SectionTitle, Tag, accents, cx, type HexColor } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, TextInput, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { cisByAttributeInfiniteQuery, nextFreeIpQuery, subnetsQuery, type AttributedCi, type SubnetNode } from '@/lib/estate-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

export interface IpamViewProps {
  locale: Locale;
}

type Tab = 'subnets' | 'dns' | 'dhcp';
const TABS: readonly Tab[] = ['subnets', 'dns', 'dhcp'];

/** Flattens the tree depth-first with the depth of each node. */
export function flattenSubnets(nodes: ReadonlyArray<SubnetNode>, depth = 0): Array<{ node: SubnetNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenSubnets(node.children, depth + 1)]);
}

/** Utilisation colour from the shared thresholds. */
export function utilisationAccent(percent: number): HexColor {
  if (percent >= IPAM.criticalUtilisationPercent) return accents.rose;
  if (percent >= IPAM.warnUtilisationPercent) return accents.amber;
  return accents.cyan;
}

function str(attributes: Record<string, unknown>, key: string): string {
  const v = attributes[key];
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

export function IpamView({ locale }: IpamViewProps): ReactNode {
  const t = useT();
  const [tab, setTab] = useState<Tab>('subnets');
  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('ipam.subtitle')}
        action={
          <div className="flex gap-om-6" role="group" aria-label={t('ipam.title')}>
            {TABS.map((x) => (
              <Pill
                key={x}
                variant={tab === x ? 'primary' : 'default'}
                onClick={() => {
                  setTab(x);
                }}
              >
                {t(('ipam.tab.' + x) as MessageKey)}
              </Pill>
            ))}
          </div>
        }
      >
        {t('ipam.title')}
      </SectionTitle>
      {tab === 'subnets' ? <SubnetsTab locale={locale} /> : tab === 'dns' ? <DnsTab locale={locale} /> : <DhcpTab locale={locale} />}
    </div>
  );
}

function SubnetsTab({ locale }: IpamViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const subnets = useQuery(subnetsQuery());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SubnetNode | null>(null);
  const rows = useMemo(() => {
    const all = flattenSubnets(subnets.data ?? []);
    // Hide descendants of collapsed nodes.
    const out: Array<{ node: SubnetNode; depth: number }> = [];
    let hideBelow: number | null = null;
    for (const r of all) {
      if (hideBelow !== null && r.depth > hideBelow) continue;
      hideBelow = null;
      out.push(r);
      if (collapsed.has(r.node.ci.id)) hideBelow = r.depth;
    }
    return out;
  }, [subnets.data, collapsed]);
  const all = useMemo(() => flattenSubnets(subnets.data ?? []), [subnets.data]);
  const leaves = all.filter((r) => r.node.children.length === 0);
  const avg = leaves.length === 0 ? 0 : leaves.reduce((s, r) => s + r.node.utilisationPercent, 0) / leaves.length;
  const hot = leaves.filter((r) => r.node.utilisationPercent >= IPAM.warnUtilisationPercent).length;

  return (
    <>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi label={t('ipam.kpi.subnets')} value={format.integer(all.length)} />
        <Kpi label={t('ipam.kpi.leaves')} value={format.integer(leaves.length)} />
        <Kpi label={t('ipam.kpi.avgUtilisation')} value={format.number(avg)} unit="%" />
        <Kpi label={t('ipam.kpi.hot', { percent: format.integer(IPAM.warnUtilisationPercent) })} value={format.integer(hot)} />
      </div>
      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[3fr_2fr]">
        <Card padding="24" className="flex flex-col gap-om-12">
          <SectionTitle as="h2" size="sm" description={t('ipam.tree.subtitle')} action={<Icon name="ipam" className="size-5 text-om-cyan" />}>
            {t('ipam.tree.title')}
          </SectionTitle>
          {subnets.isPending ? (
            <QueryState status="pending" />
          ) : subnets.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void subnets.refetch();
              }}
            />
          ) : rows.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('ipam.tree.empty')}</p>
          ) : (
            <ul className="flex flex-col" role="tree" aria-label={t('ipam.tree.title')}>
              {rows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isCollapsed = collapsed.has(node.ci.id);
                return (
                  <li key={node.ci.id} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined} aria-selected={selected?.ci.id === node.ci.id} className={cx('flex items-center gap-om-8 border-t border-om-border-glass py-om-6', selected?.ci.id === node.ci.id && 'bg-om-surface2')} style={{ paddingInlineStart: depth * IPAM.treeIndentPx }}>
                    <button
                      type="button"
                      aria-label={isCollapsed ? t('ipam.tree.expand', { cidr: node.cidr }) : t('ipam.tree.collapse', { cidr: node.cidr })}
                      disabled={!hasChildren}
                      onClick={() => {
                        setCollapsed((c) => {
                          const next = new Set(c);
                          if (next.has(node.ci.id)) next.delete(node.ci.id);
                          else next.add(node.ci.id);
                          return next;
                        });
                      }}
                      className="grid size-5 place-items-center rounded-om-control text-om-muted disabled:opacity-30"
                    >
                      <Icon name="chevronDown" className={cx('size-3 transition-transform duration-om-base', isCollapsed && '-rotate-90 rtl:rotate-90')} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(node);
                      }}
                      className="font-om-mono text-om-sm text-om-primary hover:text-om-cyan"
                    >
                      {node.cidr}
                    </button>
                    {node.vrf !== null ? <Tag>{node.vrf}</Tag> : null}
                    {hasChildren ? <span className="text-om-2xs text-om-muted">{t('ipam.tree.children', { count: format.integer(node.children.length) })}</span> : null}
                    <span className="ms-auto flex w-40 items-center gap-om-8">
                      <Bar value={node.utilisationPercent} accent={utilisationAccent(node.utilisationPercent)} label={t('ipam.subnet.utilisation') + ' ' + node.cidr + ' ' + format.number(node.utilisationPercent) + '%'} />
                      <span className="w-12 text-end font-om-mono text-om-2xs text-om-secondary">{format.number(node.utilisationPercent) + '%'}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <SubnetPanel locale={locale} subnet={selected} />
      </div>
    </>
  );
}

function SubnetPanel({ locale, subnet }: { locale: Locale; subnet: SubnetNode | null }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const nextFree = useQuery({ ...nextFreeIpQuery(subnet?.ci.id ?? ''), enabled: subnet !== null });
  const addresses = useInfiniteQuery({ ...cisByAttributeInfiniteQuery(['ip_address'], subnet === null ? null : { subnet: subnet.cidr }), enabled: subnet !== null });
  const rows = addresses.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [];
  const total = addresses.data?.pages[0]?.totalCount ?? 0;

  return (
    <section aria-label={t('ipam.subnet.title')}>
      <Card padding="24" className="flex flex-col gap-om-12">
      <SectionTitle as="h2" size="sm" description={subnet === null ? t('ipam.subnet.pick') : subnet.ci.displayName}>
        {subnet === null ? t('ipam.subnet.title') : subnet.cidr}
      </SectionTitle>
      {subnet === null ? null : (
        <>
          <dl className="grid grid-cols-2 gap-om-10 text-om-xs">
            <div>
              <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('ipam.subnet.utilisation')}</dt>
              <dd className="font-om-mono text-om-primary">{format.number(subnet.utilisationPercent) + '%'}</dd>
            </div>
            <div>
              <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('ipam.subnet.nextFree')}</dt>
              <dd className="font-om-mono text-om-emerald">{nextFree.isPending ? t('common.loading') : (nextFree.data ?? t('ipam.subnet.full'))}</dd>
            </div>
          </dl>
          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(subnet.ci.id))} className="text-om-xs text-om-cyan hover:underline">
            {t('ipam.subnet.openCi')}
          </Link>
          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('ipam.addresses.title', { count: format.integer(total) })}</span>
          {addresses.isPending ? (
            <QueryState status="pending" />
          ) : addresses.isError ? (
            <QueryState status="error" />
          ) : rows.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('ipam.addresses.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('ipam.addresses.address')}</th>
                    <th scope="col" className={thClass}>{t('ipam.addresses.status')}</th>
                    <th scope="col" className={thClass}>{t('ipam.addresses.interface')}</th>
                    <th scope="col" className={thClass}>{t('ipam.addresses.mac')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className={rowClass}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>
                        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(a.id))} className="hover:text-om-cyan">
                          {a.identity['address'] ?? a.name}
                        </Link>
                      </td>
                      <td className={tdClass}>
                        <Tag>{str(a.attributes, 'status')}</Tag>
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>{str(a.attributes, 'interface')}</td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>{str(a.attributes, 'macAddress')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {addresses.hasNextPage ? (
            <Button
              tone="quiet"
              className="self-start"
              disabled={addresses.isFetchingNextPage}
              onClick={() => {
                void addresses.fetchNextPage();
              }}
            >
              {t('common.more')}
            </Button>
          ) : null}
        </>
      )}
      </Card>
    </section>
  );
}

function CiTable({ locale, title, rows, columns, total, hasMore, loadMore, loading }: { locale: Locale; title: string; rows: AttributedCi[]; columns: Array<{ key: string; label: string; from: 'identity' | 'attributes' | 'name' }>; total: number; hasMore: boolean; loadMore: () => void; loading: boolean }): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <div className="flex flex-col gap-om-8">
      <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{title + ' · ' + format.integer(total)}</span>
      {rows.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('common.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={thClass}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((ci) => (
                <tr key={ci.id} className={rowClass}>
                  {columns.map((c, i) => {
                    const value = c.from === 'name' ? ci.name : c.from === 'identity' ? (ci.identity[c.key] ?? '') : str(ci.attributes, c.key);
                    return (
                      <td key={c.key} className={tdClass + ' font-om-mono ' + (i === 0 ? 'text-om-primary' : 'text-om-secondary')}>
                        {i === 0 ? (
                          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))} className="hover:text-om-cyan">
                            {value}
                          </Link>
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore ? (
        <Button tone="quiet" className="self-start" disabled={loading} onClick={loadMore}>
          {t('common.more')}
        </Button>
      ) : null}
    </div>
  );
}

function DnsTab({ locale }: IpamViewProps): ReactNode {
  const t = useT();
  const [search, setSearch] = useState('');
  const zones = useInfiniteQuery(cisByAttributeInfiniteQuery(['dns_zone'], null));
  const records = useInfiniteQuery(cisByAttributeInfiniteQuery(['dns_record'], null, search.trim() === '' ? null : search.trim()));
  const zoneRows = zones.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [];
  const recordRows = records.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [];
  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle
        as="h2"
        size="sm"
        description={t('ipam.dns.subtitle')}
        action={
          <TextInput
            aria-label={t('ipam.dns.search')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            className="w-64"
          />
        }
      >
        {t('ipam.dns.title')}
      </SectionTitle>
      {zones.isPending || records.isPending ? (
        <QueryState status="pending" />
      ) : zones.isError || records.isError ? (
        <QueryState status="error" />
      ) : (
        <>
          <CiTable
            locale={locale}
            title={t('ipam.dns.zones')}
            rows={zoneRows}
            total={zones.data.pages[0]?.totalCount ?? 0}
            hasMore={zones.hasNextPage}
            loading={zones.isFetchingNextPage}
            loadMore={() => {
              void zones.fetchNextPage();
            }}
            columns={[
              { key: 'name', label: t('ipam.dns.zone'), from: 'name' },
              { key: 'type', label: t('ipam.dns.zoneType'), from: 'attributes' },
              { key: 'server', label: t('ipam.dns.server'), from: 'attributes' },
              { key: 'recordCount', label: t('ipam.dns.records'), from: 'attributes' },
              { key: 'dnssec', label: 'DNSSEC', from: 'attributes' },
            ]}
          />
          <CiTable
            locale={locale}
            title={t('ipam.dns.records')}
            rows={recordRows}
            total={records.data.pages[0]?.totalCount ?? 0}
            hasMore={records.hasNextPage}
            loading={records.isFetchingNextPage}
            loadMore={() => {
              void records.fetchNextPage();
            }}
            columns={[
              { key: 'name', label: t('ipam.dns.record'), from: 'identity' },
              { key: 'recordType', label: t('ipam.dns.recordType'), from: 'identity' },
              { key: 'value', label: t('ipam.dns.value'), from: 'identity' },
              { key: 'zoneRef', label: t('ipam.dns.zone'), from: 'identity' },
            ]}
          />
        </>
      )}
    </Card>
  );
}

function DhcpTab({ locale }: IpamViewProps): ReactNode {
  const t = useT();
  const scopes = useInfiniteQuery(cisByAttributeInfiniteQuery(['dhcp_scope'], null));
  const leases = useInfiniteQuery(cisByAttributeInfiniteQuery(['dhcp_lease'], null));
  const scopeRows = scopes.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [];
  const leaseRows = leases.data?.pages.flatMap((p) => p.edges.map((e) => e.node)) ?? [];
  return (
    <Card padding="24" className="flex flex-col gap-om-16">
      <SectionTitle as="h2" size="sm" description={t('ipam.dhcp.subtitle')}>
        {t('ipam.dhcp.title')}
      </SectionTitle>
      {scopes.isPending || leases.isPending ? (
        <QueryState status="pending" />
      ) : scopes.isError || leases.isError ? (
        <QueryState status="error" />
      ) : (
        <>
          <CiTable
            locale={locale}
            title={t('ipam.dhcp.scopes')}
            rows={scopeRows}
            total={scopes.data.pages[0]?.totalCount ?? 0}
            hasMore={scopes.hasNextPage}
            loading={scopes.isFetchingNextPage}
            loadMore={() => {
              void scopes.fetchNextPage();
            }}
            columns={[
              { key: 'cidr', label: t('ipam.dhcp.scope'), from: 'identity' },
              { key: 'server', label: t('ipam.dns.server'), from: 'attributes' },
              { key: 'rangeStart', label: t('ipam.dhcp.rangeStart'), from: 'attributes' },
              { key: 'rangeEnd', label: t('ipam.dhcp.rangeEnd'), from: 'attributes' },
              { key: 'gateway', label: t('ipam.dhcp.gateway'), from: 'attributes' },
              { key: 'leaseSeconds', label: t('ipam.dhcp.lease'), from: 'attributes' },
            ]}
          />
          <CiTable
            locale={locale}
            title={t('ipam.dhcp.leases')}
            rows={leaseRows}
            total={leases.data.pages[0]?.totalCount ?? 0}
            hasMore={leases.hasNextPage}
            loading={leases.isFetchingNextPage}
            loadMore={() => {
              void leases.fetchNextPage();
            }}
            columns={[
              { key: 'address', label: t('ipam.addresses.address'), from: 'identity' },
              { key: 'scopeRef', label: t('ipam.dhcp.scope'), from: 'identity' },
              { key: 'mac', label: t('ipam.addresses.mac'), from: 'attributes' },
              { key: 'hostname', label: t('ipam.dhcp.hostname'), from: 'attributes' },
              { key: 'expiresAt', label: t('ipam.dhcp.expires'), from: 'attributes' },
            ]}
          />
        </>
      )}
    </Card>
  );
}
