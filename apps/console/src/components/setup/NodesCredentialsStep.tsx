'use client';
// REQ-UI-024 — step 4: Discovery Nodes (registered here, enrolled on the host with the one-time token shown once),
// credential sets (written to OpenBao, reference kept) and discovery scopes (subnet CIs located at a site).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DISCOVERY_NODE_ENV, SETUP_LIMITS } from '@openmap/constants';
import { CREDENTIAL_FIELDS, CREDENTIAL_TYPES, type CredentialType } from '@openmap/contracts';
import { Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { addDiscoveryScope, onboardingQueryKey, registerNode, saveCredentialSet, type CredentialSetInput, type NodeRegistration, type OnboardingState, type ScopeInput } from '@/lib/setup-queries';
import type { DiscoveryNode } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { MutationError, PRIMARY_BUTTON, SelectInput, StepCard, TABLE_HEAD, TextInput, FIELD_CLASS, LABEL_CLASS } from './fields';
import { StepActions, type StepProps } from './SetupView';

const NODE_STATUSES = ['pending', 'enrolled', 'online', 'offline', 'degraded', 'cloud_managed', 'agent_only'] as const;
type NodeStatus = (typeof NODE_STATUSES)[number];
const CREDENTIAL_FIELD_NAMES = ['community', 'username', 'password', 'domain', 'authProtocol', 'authPassphrase', 'privProtocol', 'privPassphrase', 'contextName', 'privateKey', 'passphrase', 'token', 'clientId', 'clientSecret', 'tenantId', 'tokenUrl', 'scope', 'certificatePem', 'privateKeyPem', 'kubeconfig', 'accessKeyId', 'accessKeySecret', 'roleArn', 'clientEmail', 'adminEmail', 'subscriptionId'] as const;
type CredentialFieldName = (typeof CREDENTIAL_FIELD_NAMES)[number];
const CREDENTIAL_TYPE_OPTIONS = CREDENTIAL_TYPES.filter((type) => type !== 'none');

function isNodeStatus(status: string): status is NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(status);
}

function isFieldName(name: string): name is CredentialFieldName {
  return (CREDENTIAL_FIELD_NAMES as readonly string[]).includes(name);
}

/** The command an operator runs on the site's host: the token, scheduler and identity as environment, then enrol. */
export function enrolCommand(registration: NodeRegistration): string {
  return [
    DISCOVERY_NODE_ENV.enrolToken + '=' + registration.enrolToken,
    DISCOVERY_NODE_ENV.schedulerUrl + '=' + registration.schedulerUrl,
    DISCOVERY_NODE_ENV.nodeId + '=' + registration.node.id,
    DISCOVERY_NODE_ENV.siteCode + '=' + registration.siteCode,
    DISCOVERY_NODE_ENV.binary + ' enrol',
  ].join(' ');
}

export function NodesCredentialsStep({ state, editable, onContinue, onBack, continuing }: StepProps): ReactNode {
  const t = useT();
  return (
    <StepCard
      title={t('setup.step.nodes_credentials')}
      description={t('setup.nodes.subtitle')}
      actions={<StepActions onBack={onBack} onContinue={onContinue} continuing={continuing} continueLabel={t('setup.next')} />}
    >
      <NodesSection state={state} editable={editable} />
      <CredentialsSection state={state} editable={editable} />
      <ScopesSection state={state} editable={editable} />
    </StepCard>
  );
}

interface SectionProps {
  state: OnboardingState;
  editable: boolean;
}

function nodeStatusLabel(t: ReturnType<typeof useT>, node: DiscoveryNode): string {
  return isNodeStatus(node.status) ? t(`setup.nodes.status.${node.status}`) : t('setup.nodes.status.other', { status: node.status });
}

function NodesSection({ state, editable }: SectionProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const queryClient = useQueryClient();
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [nodeId, setNodeId] = useState('');
  const [registration, setRegistration] = useState<NodeRegistration | null>(null);
  const register = useMutation({
    mutationFn: () => registerNode(siteId, nodeId.trim()),
    onSuccess: async (result) => {
      setRegistration(result);
      setNodeId('');
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || siteId === '' || nodeId.trim() === '') return;
    register.mutate();
  };

  return (
    <section aria-label={t('setup.nodes.title')} className="flex flex-col gap-om-12">
      <h3 className="text-om-sm font-semibold text-om-primary">{t('setup.nodes.title')}</h3>
      {state.nodes.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.nodes.none')}</p>
      ) : (
        <ul className="flex flex-col gap-om-6">
          {state.nodes.map((node) => (
            <li key={node.id} className="flex flex-wrap items-center gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-8 text-om-sm">
              <span className="font-om-mono text-om-xs text-om-cyan">{node.id}</span>
              <Tag>{nodeStatusLabel(t, node)}</Tag>
              <span className="text-om-2xs text-om-muted">{node.site?.displayName ?? t('discovery.nodes.noSite')}</span>
              <span className="text-om-2xs text-om-muted">{t('discovery.nodes.heartbeat', { when: format.dateTime(node.lastHeartbeat) })}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-om-2xs text-om-muted">{t('setup.nodes.cloudHint')}</p>
      <form onSubmit={onSubmit} aria-label={t('setup.nodes.register')} className="flex flex-wrap items-end gap-om-12">
        <SelectInput id={id + '-site'} label={t('setup.nodes.site')} value={siteId} disabled={!editable} onChange={(e) => { setSiteId(e.target.value); }}>
          {state.sites.map((site) => (
            <option key={site.id} value={site.id}>{site.code + ' · ' + site.name}</option>
          ))}
        </SelectInput>
        <TextInput id={id + '-node'} label={t('setup.nodes.nodeId')} hint={t('setup.nodes.nodeIdHint')} value={nodeId} required disabled={!editable} onChange={(e) => { setNodeId(e.target.value.toLowerCase()); }} />
        <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || register.isPending || siteId === '' || nodeId.trim() === ''}>
          {t('setup.nodes.register')}
        </button>
        <MutationError error={register.error} />
      </form>
      {registration === null ? null : (
        <div role="status" className="flex flex-col gap-om-8 rounded-om-panel border border-om-cyan/30 bg-om-cyan/10 p-om-12">
          <p className="text-om-sm text-om-primary">{t('setup.nodes.registered', { node: registration.node.id, site: registration.siteCode })}</p>
          <p className={LABEL_CLASS}>{t('setup.nodes.token')}</p>
          <code data-testid="enrol-token" className="break-all font-om-mono text-om-xs text-om-cyan">{registration.enrolToken}</code>
          <p className="text-om-2xs text-om-muted">{t('setup.nodes.install')}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-om-control bg-om-surface3 p-om-10 font-om-mono text-om-2xs text-om-secondary">{enrolCommand(registration)}</pre>
        </div>
      )}
    </section>
  );
}

function CredentialsSection({ state, editable }: SectionProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [ref, setRef] = useState('');
  const [type, setType] = useState<CredentialType>(CREDENTIAL_TYPE_OPTIONS[0] ?? 'password');
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (input: CredentialSetInput) => saveCredentialSet(input),
    onSuccess: async () => {
      setRef('');
      setFields({});
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const spec = CREDENTIAL_FIELDS[type];
  const complete = spec.required.every((name) => (fields[name] ?? '').trim() !== '');
  const fieldLabel = (name: string): string => (isFieldName(name) ? t(`setup.credentials.field.${name}`) : name);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || ref.trim() === '' || !complete) return;
    const sent: Record<string, string> = {};
    for (const name of [...spec.required, ...spec.optional]) if ((fields[name] ?? '').trim() !== '') sent[name] = fields[name] ?? '';
    save.mutate({ ref: ref.trim(), type, fields: sent });
  };

  return (
    <section aria-label={t('setup.credentials.title')} className="flex flex-col gap-om-12 border-t border-om-border-glass pt-om-16">
      <h3 className="text-om-sm font-semibold text-om-primary">{t('setup.credentials.title')}</h3>
      <p className="text-om-2xs text-om-muted">{t('setup.credentials.subtitle')}</p>
      {state.credentials.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.credentials.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-om-6">
          {state.credentials.map((credential) => (
            <li key={credential.ref} className="flex flex-wrap items-center gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-8 text-om-sm">
              <span className="font-om-mono text-om-xs text-om-cyan">{credential.ref}</span>
              <Tag>{t(`setup.credentials.type.${credential.type as CredentialType}`)}</Tag>
              <span className="text-om-2xs text-om-muted">{t('setup.credentials.fields', { fields: credential.fields.map(fieldLabel).join(', ') })}</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onSubmit} aria-label={t('setup.credentials.save')} className="flex flex-col gap-om-12">
        <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
          <TextInput id={id + '-ref'} label={t('setup.credentials.ref')} hint={t('setup.credentials.refHint')} value={ref} required disabled={!editable} onChange={(e) => { setRef(e.target.value); }} />
          <SelectInput id={id + '-type'} label={t('setup.credentials.type')} value={type} disabled={!editable} onChange={(e) => { setType(e.target.value as CredentialType); setFields({}); }}>
            {CREDENTIAL_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>{t(`setup.credentials.type.${option}`)}</option>
            ))}
          </SelectInput>
        </div>
        <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
          {[...spec.required, ...spec.optional].map((name) => {
            const secret = spec.secret.includes(name);
            const required = spec.required.includes(name);
            const multiline = name.endsWith('Pem') || name === 'kubeconfig' || name === 'privateKey';
            const label = required ? fieldLabel(name) : fieldLabel(name) + ' (' + t('setup.credentials.optional') + ')';
            return multiline ? (
              <div key={name} className="flex flex-col gap-om-4 md:col-span-3">
                <label htmlFor={id + '-f-' + name} className={LABEL_CLASS}>{label}</label>
                <textarea id={id + '-f-' + name} rows={SETUP_LIMITS.secretTextareaRows} className={FIELD_CLASS + ' font-om-mono'} value={fields[name] ?? ''} required={required} disabled={!editable} onChange={(e) => { setFields((f) => ({ ...f, [name]: e.target.value })); }} />
              </div>
            ) : (
              <TextInput key={name} id={id + '-f-' + name} label={label} type={secret ? 'password' : 'text'} autoComplete="off" value={fields[name] ?? ''} required={required} disabled={!editable} onChange={(e) => { setFields((f) => ({ ...f, [name]: e.target.value })); }} />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-om-12">
          <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || save.isPending || ref.trim() === '' || !complete}>
            {t('setup.credentials.save')}
          </button>
          <MutationError error={save.error} />
        </div>
      </form>
    </section>
  );
}

function ScopesSection({ state, editable }: SectionProps): ReactNode {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [cidr, setCidr] = useState('');
  const [vrf, setVrf] = useState('');
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [credentialRef, setCredentialRef] = useState('');
  const add = useMutation({
    mutationFn: (input: ScopeInput) => addDiscoveryScope(input),
    onSuccess: async () => {
      setCidr('');
      await queryClient.invalidateQueries({ queryKey: onboardingQueryKey });
    },
  });
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!editable || cidr.trim() === '' || siteId === '') return;
    const credential = state.credentials.find((c) => c.ref === credentialRef);
    add.mutate({ cidr: cidr.trim(), vrf: vrf.trim() === '' ? null : vrf.trim(), siteId, credentialRef: credential?.ref ?? null, credentialType: credential?.type ?? null });
  };

  return (
    <section aria-label={t('setup.scopes.title')} className="flex flex-col gap-om-12 border-t border-om-border-glass pt-om-16">
      <h3 className="text-om-sm font-semibold text-om-primary">{t('setup.scopes.title')}</h3>
      <p className="text-om-2xs text-om-muted">{t('setup.scopes.subtitle')}</p>
      {state.scopes.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('setup.scopes.empty')}</p>
      ) : (
        <table className="w-full text-om-sm" aria-label={t('setup.scopes.title')}>
          <thead>
            <tr className={TABLE_HEAD}>
              <th scope="col" className="py-om-6 text-start">{t('setup.scopes.column.cidr')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.scopes.column.site')}</th>
              <th scope="col" className="py-om-6 text-start">{t('setup.scopes.column.credential')}</th>
            </tr>
          </thead>
          <tbody>
            {state.scopes.map((scope) => (
              <tr key={scope.ci.id} className="border-t border-om-border-glass">
                <td className="py-om-8 font-om-mono text-om-xs text-om-cyan">{scope.cidr}</td>
                <td className="py-om-8 text-om-secondary">{scope.site?.displayName ?? t('discovery.nodes.noSite')}</td>
                <td className="py-om-8 font-om-mono text-om-2xs text-om-muted">{scope.credentialRef ?? t('common.none')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={onSubmit} aria-label={t('setup.scopes.add')} className="flex flex-wrap items-end gap-om-12">
        <TextInput id={id + '-cidr'} label={t('setup.scopes.cidr')} value={cidr} required disabled={!editable} onChange={(e) => { setCidr(e.target.value); }} />
        <TextInput id={id + '-vrf'} label={t('setup.scopes.vrf')} value={vrf} disabled={!editable} onChange={(e) => { setVrf(e.target.value); }} />
        <SelectInput id={id + '-site'} label={t('setup.scopes.site')} value={siteId} disabled={!editable} onChange={(e) => { setSiteId(e.target.value); }}>
          {state.sites.map((site) => (
            <option key={site.id} value={site.id}>{site.code + ' · ' + site.name}</option>
          ))}
        </SelectInput>
        <SelectInput id={id + '-cred'} label={t('setup.scopes.credential')} value={credentialRef} disabled={!editable} onChange={(e) => { setCredentialRef(e.target.value); }}>
          <option value="">{t('setup.scopes.noCredential')}</option>
          {state.credentials.map((credential) => (
            <option key={credential.ref} value={credential.ref}>{credential.ref}</option>
          ))}
        </SelectInput>
        <button type="submit" className={PRIMARY_BUTTON} disabled={!editable || add.isPending || cidr.trim() === '' || siteId === ''}>
          {t('setup.scopes.add')}
        </button>
        <MutationError error={add.error} />
      </form>
    </section>
  );
}
