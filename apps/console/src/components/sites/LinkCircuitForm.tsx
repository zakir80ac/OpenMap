'use client';
// REQ-IPAM-007 (ADR-069) — the network circuit register's edit of one inter-site link: kind, carrier, carrier contract,
// committed bandwidth and latency, diverse paths, role, the physical route it takes, and the carrier circuits (recorded
// on the DCIM Cabling tab) it rides on. Saving puts each chosen circuit under the link in the impact graph, and the
// readiness rules judge the link's diversity from what is recorded here.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LINK_CIRCUITS } from '@openmap/constants';
import { LINK_KINDS, LINK_ROLES } from '@openmap/contracts';
import { Card, SectionTitle } from '@openmap/ui';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Select, TextInput } from '@/components/common/controls';
import { cablingQuery } from '@/lib/cabling-queries';
import {
  connectivityKey,
  saveLinkCircuit,
  type ConnectivityLink,
  type LinkCircuitInput,
} from '@/lib/queries';
import { useT } from '@/providers';

const labelClass =
  'flex flex-col gap-om-4 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
type LinkKind = (typeof LINK_KINDS)[number];
type LinkRole = (typeof LINK_ROLES)[number];

interface Draft {
  kind: LinkKind;
  provider: string;
  carrierContractRef: string;
  bandwidthMbps: string;
  slaLatencyMs: string;
  diversePaths: string;
  role: LinkRole;
  pathRef: string;
  circuitCiIds: string[];
}

function isKind(v: string | null): v is LinkKind {
  return v !== null && (LINK_KINDS as readonly string[]).includes(v);
}
function isRole(v: string | null): v is LinkRole {
  return v !== null && (LINK_ROLES as readonly string[]).includes(v);
}

export function draftOf(link: ConnectivityLink): Draft {
  return {
    kind: isKind(link.kind) ? link.kind : LINK_KINDS[0],
    provider: link.provider ?? '',
    carrierContractRef: link.carrierContractRef ?? '',
    bandwidthMbps: link.capacityMbps === null ? '' : String(link.capacityMbps),
    slaLatencyMs: link.slaLatencyMs === null ? '' : String(link.slaLatencyMs),
    diversePaths: String(link.diversePaths),
    role: isRole(link.role) ? link.role : LINK_ROLES[0],
    pathRef: link.pathRef ?? '',
    circuitCiIds: link.circuits.map((c) => c.ci.id),
  };
}

function text(v: string): string | null {
  return v.trim() === '' ? null : v.trim();
}

function whole(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/** The input a valid draft saves; null while a required figure is missing or not a whole positive number. */
export function inputOf(draft: Draft): LinkCircuitInput | null {
  const bandwidthMbps = whole(draft.bandwidthMbps);
  const diversePaths = whole(draft.diversePaths);
  const slaLatencyMs = draft.slaLatencyMs.trim() === '' ? null : whole(draft.slaLatencyMs);
  if (bandwidthMbps === null || diversePaths === null || diversePaths > LINK_CIRCUITS.maxDiversePaths)
    return null;
  if (draft.slaLatencyMs.trim() !== '' && slaLatencyMs === null) return null;
  return {
    kind: draft.kind,
    provider: text(draft.provider),
    carrierContractRef: text(draft.carrierContractRef),
    bandwidthMbps,
    slaLatencyMs,
    diversePaths,
    role: draft.role,
    pathRef: text(draft.pathRef),
    circuitCiIds: draft.circuitCiIds,
  };
}

export function LinkCircuitForm({ link, onDone }: { link: ConnectivityLink; onDone: () => void }): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(link));
  const circuits = useQuery({ ...cablingQuery(), select: (c) => c.circuits });
  const input = inputOf(draft);
  const save = useMutation({
    mutationFn: (value: LinkCircuitInput) => saveLinkCircuit(link.ci.id, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectivityKey });
      onDone();
    },
  });
  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const toggle = (id: string, on: boolean): void => {
    setDraft((d) => ({
      ...d,
      circuitCiIds: on ? [...d.circuitCiIds, id] : d.circuitCiIds.filter((c) => c !== id),
    }));
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (input !== null) save.mutate(input);
  };
  const atLimit = draft.circuitCiIds.length >= LINK_CIRCUITS.maxCircuitsPerLink;

  return (
    <Card className="flex flex-col gap-om-10">
      <SectionTitle as="h3" size="sm" description={t('sites.circuit.description')}>
        {t('sites.circuit.title', { link: link.ci.displayName })}
      </SectionTitle>
      <form
        aria-label={t('sites.circuit.form', { link: link.ci.displayName })}
        onSubmit={onSubmit}
        className="flex flex-col gap-om-10"
      >
        <div className="grid grid-cols-1 gap-om-10 md:grid-cols-3">
          <label className={labelClass}>
            {t('setup.links.kind')}
            <Select
              value={draft.kind}
              onChange={(e) => {
                update('kind', e.target.value as LinkKind);
              }}
            >
              {LINK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`setup.links.kind.${k}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className={labelClass}>
            {t('setup.links.role')}
            <Select
              value={draft.role}
              onChange={(e) => {
                update('role', e.target.value as LinkRole);
              }}
            >
              {LINK_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`setup.links.role.${r}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className={labelClass}>
            {t('setup.links.provider')}
            <TextInput
              value={draft.provider}
              maxLength={LINK_CIRCUITS.maxRefChars}
              onChange={(e) => {
                update('provider', e.target.value);
              }}
            />
          </label>
          <label className={labelClass}>
            {t('setup.links.contract')}
            <TextInput
              value={draft.carrierContractRef}
              maxLength={LINK_CIRCUITS.maxRefChars}
              onChange={(e) => {
                update('carrierContractRef', e.target.value);
              }}
            />
          </label>
          <label className={labelClass}>
            {t('setup.links.bandwidth')}
            <TextInput
              required
              inputMode="numeric"
              value={draft.bandwidthMbps}
              onChange={(e) => {
                update('bandwidthMbps', e.target.value);
              }}
            />
          </label>
          <label className={labelClass}>
            {t('setup.links.slaLatency')}
            <TextInput
              inputMode="numeric"
              value={draft.slaLatencyMs}
              onChange={(e) => {
                update('slaLatencyMs', e.target.value);
              }}
            />
          </label>
          <label className={labelClass}>
            {t('setup.links.paths')}
            <TextInput
              required
              inputMode="numeric"
              value={draft.diversePaths}
              onChange={(e) => {
                update('diversePaths', e.target.value);
              }}
            />
          </label>
          <label className={labelClass}>
            {t('setup.links.pathRef')}
            <TextInput
              value={draft.pathRef}
              maxLength={LINK_CIRCUITS.maxRefChars}
              onChange={(e) => {
                update('pathRef', e.target.value);
              }}
            />
          </label>
        </div>
        <fieldset className="flex flex-col gap-om-6">
          <legend className={labelClass}>{t('sites.circuit.carriers')}</legend>
          {circuits.isPending ? (
            <p className="text-om-xs text-om-muted">{t('sites.circuit.loading')}</p>
          ) : circuits.isError ? (
            <p role="alert" className="text-om-xs text-om-state-down">
              {circuits.error.message}
            </p>
          ) : circuits.data.length === 0 ? (
            <p className="text-om-xs text-om-secondary">{t('sites.circuit.noCircuits')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-om-4 md:grid-cols-2">
              {circuits.data.map((c) => {
                const on = draft.circuitCiIds.includes(c.ci.id);
                return (
                  <li key={c.ci.id}>
                    <label className="flex items-center gap-om-6 text-om-xs text-om-primary">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && atLimit}
                        onChange={(e) => {
                          toggle(c.ci.id, e.target.checked);
                        }}
                      />
                      {t('sites.circuit.option', { provider: c.provider, circuit: c.circuitId })}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-om-10">
          <Button type="submit" disabled={input === null || save.isPending}>
            {t('sites.circuit.save')}
          </Button>
          <Button tone="quiet" onClick={onDone}>
            {t('action.cancel')}
          </Button>
          {save.isError ? (
            <p role="alert" className="text-om-xs text-om-state-down">
              {save.error.message}
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
