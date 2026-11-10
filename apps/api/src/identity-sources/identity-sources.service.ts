// REQ-INT-016 (ADR-074) — identity sources: administrators register directories (Active Directory, other LDAP) and
// OpenID Connect providers (Entra ID, Okta, other); the API stores each one (secrets as OpenBao refs) and applies it to
// the Keycloak realm people sign in to through Keycloak's admin REST API: an LDAP user-storage component with OpenMap's
// group and tenant mappers, or a brokered provider with tenant and claim-to-role mappers; group mappings become realm
// roles on the groups below `/<alias>`. Tests are Keycloak's own (its LDAP connection and bind test, its read of the
// discovery document); a sync imports the directory's groups then its users. Every change carries an audit event.
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { HTTP, IDENTITY_FEDERATION } from '@openmap/constants';
import {
  CLOUD_IDENTITY_VENDORS,
  IDENTITY_SOURCE_STATES,
  IDENTITY_SOURCE_VENDORS,
  discoveryUrl,
  identityRoleMappingSchema,
  identitySourceAlias,
  isLdapVendor,
  mappedRoleOf,
  resolveLdapSettings,
  resolveOidcSettings,
  sameIssuer,
  vendorKind,
  type IdentityRoleMapping,
  type IdentitySourceKind,
  type IdentitySourceState,
  type IdentitySourceVendor,
  type LdapSourceSettings,
  type LdapVendor,
  type OidcSourceSettings,
  type ParsedIdentitySourceInput,
} from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { z } from 'zod';
import type { Actor } from '../ci/ci.service.js';
import { ENV, type Env } from '../config/env.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { KeycloakAdminClient, KeycloakError, createdId, keycloakReason } from './keycloak-admin.client.js';
import {
  KEYCLOAK,
  OWNED,
  brokerRedirectUri,
  discoveredEndpointsSchema,
  ldapComponent,
  ldapGroupMapper,
  ldapTenantMapper,
  oidcMappers,
  oidcProvider,
  rolesByGroup,
  type ComponentRepresentation,
  type DiscoveredEndpoints,
  type IdentityProviderMapperRepresentation,
} from './keycloak-mapping.js';

export interface IdentitySourceTestView {
  ok: boolean;
  message: string;
  at: Date;
}

export interface IdentitySourceSyncView {
  added: number;
  updated: number;
  removed: number;
  failed: number;
  groups: number;
  message: string;
  at: Date;
}

export interface IdentitySourceView {
  id: string;
  kind: IdentitySourceKind;
  vendor: IdentitySourceVendor;
  name: string;
  alias: string;
  enabled: boolean;
  secretRef: string;
  ldap: LdapSourceSettings | null;
  oidc: (OidcSourceSettings & { redirectUri: string }) | null;
  roleMappings: IdentityRoleMapping[];
  state: IdentitySourceState;
  lastError: string | null;
  lastTest: IdentitySourceTestView | null;
  lastSync: IdentitySourceSyncView | null;
  createdAt: Date;
  updatedAt: Date;
}

type Row = Awaited<ReturnType<PrismaClient['identitySource']['findUniqueOrThrow']>>;

const ldapSettingsSchema = z.object({
  connectionUrl: z.string(),
  startTls: z.boolean(),
  bindDn: z.string(),
  usersDn: z.string(),
  userFilter: z.string().nullable(),
  groupsDn: z.string(),
  usernameAttribute: z.string(),
  syncPeriodMinutes: z.number().nullable(),
});
const oidcSettingsSchema = z.object({
  issuer: z.string(),
  directoryTenantId: z.string().nullable(),
  domain: z.string().nullable(),
  authorizationServerId: z.string().nullable(),
  clientId: z.string(),
  scopes: z.string(),
  groupsClaim: z.string(),
});
const syncResultSchema = z.object({
  added: z.number().default(0),
  updated: z.number().default(0),
  removed: z.number().default(0),
  failed: z.number().default(0),
  status: z.string().optional(),
});
const storedSyncSchema = z.object({ added: z.number(), updated: z.number(), removed: z.number(), failed: z.number(), groups: z.number(), message: z.string() });
const idSchema = z.object({ id: z.string().min(1) });
const groupSchema = z.object({ id: z.string().min(1), name: z.string(), path: z.string().optional() });
const roleSchema = z.object({ id: z.string().min(1), name: z.string() });
const componentSchema = z.object({ id: z.string().min(1), name: z.string() });
const mapperSchema = z.object({ id: z.string().min(1), name: z.string() });

/** Air-gapped deployments cannot reach internet identity services; refuse them before anything is stored or called. */
export function assertVendorAllowed(vendor: IdentitySourceVendor, profile: Env['DEPLOY_PROFILE']): void {
  if (profile === 'airgap' && CLOUD_IDENTITY_VENDORS.includes(vendor))
    throw new ForbiddenException(vendor + ' is an internet service; the airgap profile federates on-premises directories and OpenID Connect providers only');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function storedState(value: string): IdentitySourceState {
  return (IDENTITY_SOURCE_STATES as readonly string[]).includes(value) ? (value as IdentitySourceState) : 'pending';
}

function storedVendor(value: string): IdentitySourceVendor {
  const v = IDENTITY_SOURCE_VENDORS.find((x) => x === value);
  if (v === undefined) throw new BadRequestException('identity source has an unknown vendor ' + value);
  return v;
}

function storedMappings(value: Prisma.JsonValue): IdentityRoleMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    const parsed = identityRoleMappingSchema.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

@Injectable()
export class IdentitySourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    private readonly secrets: SecretsService,
    private readonly keycloak: KeycloakAdminClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  view(row: Row): IdentitySourceView {
    const vendor = storedVendor(row.vendor);
    const kind = vendorKind(vendor);
    const ldap = kind === 'ldap' ? ldapSettingsSchema.parse(row.settings) : null;
    const oidcSettings = kind === 'oidc' ? oidcSettingsSchema.parse(row.settings) : null;
    const sync = row.lastSync === null ? null : storedSyncSchema.safeParse(row.lastSync);
    return {
      id: row.id,
      kind,
      vendor,
      name: row.name,
      alias: row.alias,
      enabled: row.enabled,
      secretRef: row.secretRef,
      ldap,
      oidc: oidcSettings === null ? null : { ...oidcSettings, redirectUri: brokerRedirectUri(this.env.PUBLIC_KEYCLOAK_URL, this.keycloak.realm, row.alias) },
      roleMappings: storedMappings(row.roleMappings),
      state: storedState(row.state),
      lastError: row.lastError,
      lastTest: row.lastTestAt === null ? null : { ok: row.lastTestOk === true, message: row.lastTestMessage ?? '', at: row.lastTestAt },
      lastSync: row.lastSyncAt === null || sync === null || !sync.success ? null : { ...sync.data, at: row.lastSyncAt },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async list(tenantId: string): Promise<IdentitySourceView[]> {
    const rows = await this.prisma.client.identitySource.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    return rows.map((r) => this.view(r));
  }

  private async row(tenantId: string, id: string): Promise<Row> {
    const row = await this.prisma.client.identitySource.findFirst({ where: { id, tenantId } });
    if (row === null) throw new NotFoundException('identity source ' + id + ' not found');
    return row;
  }

  /** Saves the source (with an audit event) and applies it to Keycloak; a failed apply is kept as state `error`. */
  async upsert(actor: Actor, id: string | null, input: ParsedIdentitySourceInput): Promise<IdentitySourceView> {
    assertVendorAllowed(input.vendor, this.env.DEPLOY_PROFILE);
    const kind = vendorKind(input.vendor);
    const existing = id === null ? null : await this.row(actor.tenantId, id);
    if (existing !== null && vendorKind(storedVendor(existing.vendor)) !== kind)
      throw new BadRequestException('a ' + kind + ' source cannot replace a ' + vendorKind(storedVendor(existing.vendor)) + ' source; add a new one');
    const settings = this.resolveSettings(input);
    const sourceId = existing?.id ?? randomUUID();
    const data = {
      kind,
      vendor: input.vendor,
      name: input.name,
      enabled: input.enabled ?? true,
      settings: settings as unknown as Prisma.InputJsonValue,
      secretRef: input.secretRef,
      roleMappings: input.roleMappings as unknown as Prisma.InputJsonValue,
      state: 'pending',
      updatedBy: actor.username,
    };
    let saved: Row;
    try {
      saved = await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
        const row =
          existing === null
            ? await tx.identitySource.create({ data: { id: sourceId, tenantId: actor.tenantId, alias: identitySourceAlias(input.name, sourceId), ...data } })
            : await tx.identitySource.update({ where: { id: existing.id }, data });
        await emit({
          type: 'openmap.audit.action',
          subject: row.id,
          data: { action: existing === null ? 'identity_source.created' : 'identity_source.updated', vendor: row.vendor, name: row.name, alias: row.alias, by: actor.username },
        });
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new BadRequestException('an identity source named "' + input.name + '" already exists');
      throw err;
    }
    return this.view(await this.apply(actor.tenantId, saved));
  }

  private resolveSettings(input: ParsedIdentitySourceInput): LdapSourceSettings | OidcSourceSettings {
    if (isLdapVendor(input.vendor)) {
      if (input.ldap === null || input.ldap === undefined) throw new BadRequestException('a directory needs its LDAP settings');
      return resolveLdapSettings(input.vendor, input.ldap);
    }
    if (input.oidc === null || input.oidc === undefined) throw new BadRequestException('an identity provider needs its OpenID Connect settings');
    return resolveOidcSettings(input.vendor, input.oidc, this.env.IDENTITY_ENTRA_AUTHORITY_URL);
  }

  /** Applies the stored source to Keycloak and records the outcome on the row. */
  private async apply(tenantId: string, row: Row): Promise<Row> {
    const view = this.view(row);
    return withSpan(TRACER_NAME, 'identity.source.apply', { 'openmap.tenant': tenantId, 'identity.kind': view.kind, 'identity.vendor': view.vendor }, async () => {
      let keycloakId: string | null = null;
      let error: string | null = null;
      try {
        keycloakId = view.ldap !== null ? await this.applyLdap(tenantId, row, view.ldap) : await this.applyOidc(tenantId, row, view);
      } catch (err) {
        error = errorText(err);
      }
      this.metrics.identitySourceOps.inc({ op: 'apply', kind: view.kind, outcome: error === null ? 'ok' : 'error' });
      return this.prisma.client.identitySource.update({
        where: { id: row.id },
        data: error === null ? { state: 'applied', keycloakId, lastError: null } : { state: 'error', lastError: error },
      });
    });
  }

  private async secretField(ref: string, kind: IdentitySourceKind): Promise<string> {
    const field = IDENTITY_FEDERATION.secretFields[kind];
    const value = (await this.secrets.read(ref))[field];
    if (value === undefined || value === '') throw new BadRequestException('the secret at ' + ref + ' has no "' + field + '" field');
    return value;
  }

  private async realmId(): Promise<string> {
    return idSchema.parse((await this.keycloak.call('GET', '')).body).id;
  }

  /** The source's user-storage component: by its recorded id, else by its name (an apply that failed half-way). */
  private async component(id: string | null, realmId: string, alias: string): Promise<string | null> {
    if (id !== null) {
      const res = await this.keycloak.request('GET', '/components/' + encodeURIComponent(id));
      if (res.ok) return id;
      if (res.status !== HTTP.status.notFound) throw new KeycloakError(res.status, keycloakReason(res.status, res.body));
    }
    const byName = await this.keycloak.call('GET', '/components?parent=' + encodeURIComponent(realmId) + '&type=' + encodeURIComponent(KEYCLOAK.userStorageType) + '&name=' + encodeURIComponent(alias));
    return z.array(componentSchema).parse(byName.body).find((c) => c.name === alias)?.id ?? null;
  }

  private async putComponent(rep: ComponentRepresentation, existingId: string | null): Promise<string> {
    if (existingId !== null) {
      await this.keycloak.call('PUT', '/components/' + encodeURIComponent(existingId), { ...rep, id: existingId });
      return existingId;
    }
    return createdId(await this.keycloak.call('POST', '/components', rep));
  }

  private async childMappers(componentId: string): Promise<Array<{ id: string; name: string }>> {
    const res = await this.keycloak.call('GET', '/components?parent=' + encodeURIComponent(componentId) + '&type=' + encodeURIComponent(KEYCLOAK.ldapMapperType));
    return z.array(componentSchema).parse(res.body);
  }

  private async applyLdap(tenantId: string, row: Row, settings: LdapSourceSettings): Promise<string> {
    const vendor = storedVendor(row.vendor) as LdapVendor;
    const bindCredential = await this.secretField(row.secretRef, 'ldap');
    const source = { alias: row.alias, vendor, enabled: row.enabled, settings };
    const realmId = await this.realmId();
    const componentId = await this.putComponent(ldapComponent(source, realmId, bindCredential), await this.component(row.keycloakId, realmId, row.alias));
    if (componentId !== row.keycloakId) await this.prisma.client.identitySource.update({ where: { id: row.id }, data: { keycloakId: componentId } });
    // The groups mapper imports below `/<alias>`, which Keycloak requires to exist before the mapper is created.
    await this.applyGroupRoles(row.alias, storedMappings(row.roleMappings));
    const mappers = new Map((await this.childMappers(componentId)).map((m) => [m.name, m.id]));
    for (const rep of [ldapGroupMapper(source, componentId), ldapTenantMapper(componentId, tenantId)]) await this.putComponent(rep, mappers.get(rep.name) ?? null);
    return componentId;
  }

  private async parentGroup(alias: string): Promise<string | null> {
    const res = await this.keycloak.call('GET', '/groups?exact=true&briefRepresentation=true&search=' + encodeURIComponent(alias));
    return z.array(groupSchema).parse(res.body).find((g) => g.name === alias)?.id ?? null;
  }

  /** The group `/<alias>` and one child per mapped group, each holding exactly the OpenMap roles its mappings grant. */
  private async applyGroupRoles(alias: string, mappings: readonly IdentityRoleMapping[]): Promise<void> {
    const parentId = (await this.parentGroup(alias)) ?? createdId(await this.keycloak.call('POST', '/groups', { name: alias }));
    const childrenPath = '/groups/' + encodeURIComponent(parentId) + '/children';
    const listed = await this.keycloak.call('GET', childrenPath + '?briefRepresentation=true&first=0&max=' + String(IDENTITY_FEDERATION.keycloakPageSize));
    const children = new Map(z.array(groupSchema).parse(listed.body).map((g) => [g.name, g.id]));
    const wanted = rolesByGroup(mappings);
    for (const name of wanted.keys()) {
      if (!children.has(name)) {
        const created = await this.keycloak.call('POST', childrenPath, { name });
        const body = idSchema.safeParse(created.body);
        children.set(name, body.success ? body.data.id : createdId(created));
      }
    }
    const roles = new Map<string, { id: string; name: string }>();
    const role = async (name: string): Promise<{ id: string; name: string }> => {
      const known = roles.get(name);
      if (known !== undefined) return known;
      const res = await this.keycloak.request('GET', '/roles/' + encodeURIComponent(name));
      if (res.status === HTTP.status.notFound) throw new BadRequestException('the realm ' + this.keycloak.realm + ' has no role ' + name);
      if (!res.ok) throw new KeycloakError(res.status, keycloakReason(res.status, res.body));
      const parsed = roleSchema.parse(res.body);
      roles.set(name, parsed);
      return parsed;
    };
    for (const [name, groupId] of children) {
      const path = '/groups/' + encodeURIComponent(groupId) + '/role-mappings/realm';
      const current = z.array(roleSchema).parse((await this.keycloak.call('GET', path)).body).filter((r) => mappedRoleOf(r.name) !== null);
      const want = wanted.get(name) ?? new Set<string>();
      const add = await Promise.all([...want].filter((r) => !current.some((c) => c.name === r)).map(role));
      const remove = current.filter((c) => !want.has(c.name));
      if (add.length > 0) await this.keycloak.call('POST', path, add);
      if (remove.length > 0) await this.keycloak.call('DELETE', path, remove);
    }
  }

  /** Keycloak reads the provider's discovery document (from where it will broker) and returns its endpoints. */
  private async discover(issuer: string): Promise<DiscoveredEndpoints> {
    const res = await this.keycloak.request('POST', '/identity-provider/import-config', { providerId: KEYCLOAK.oidcProvider, fromUrl: discoveryUrl(issuer) });
    if (!res.ok) throw new KeycloakError(res.status, 'Keycloak could not read ' + discoveryUrl(issuer) + '. ' + keycloakReason(res.status, res.body));
    const endpoints = discoveredEndpointsSchema.safeParse(res.body);
    if (!endpoints.success) throw new KeycloakError(res.status, discoveryUrl(issuer) + ' is not an OpenID Connect discovery document');
    if (!sameIssuer(endpoints.data.issuer, issuer)) throw new KeycloakError(res.status, 'the discovery document names issuer ' + endpoints.data.issuer + ', not ' + issuer);
    return endpoints.data;
  }

  private async applyOidc(tenantId: string, row: Row, view: IdentitySourceView): Promise<string> {
    const settings = view.oidc;
    if (settings === null) throw new BadRequestException('identity source ' + row.id + ' has no OpenID Connect settings');
    const clientSecret = await this.secretField(row.secretRef, 'oidc');
    const endpoints = await this.discover(settings.issuer);
    const source = { alias: row.alias, name: row.name, enabled: row.enabled, settings };
    const path = '/identity-provider/instances/' + encodeURIComponent(row.alias);
    const exists = await this.keycloak.request('GET', path);
    if (exists.status === HTTP.status.notFound) await this.keycloak.call('POST', '/identity-provider/instances', oidcProvider(source, endpoints, clientSecret));
    else if (exists.ok) await this.keycloak.call('PUT', path, oidcProvider(source, endpoints, clientSecret));
    else throw new KeycloakError(exists.status, keycloakReason(exists.status, exists.body));
    const current = new Map(z.array(mapperSchema).parse((await this.keycloak.call('GET', path + '/mappers')).body).map((m) => [m.name, m.id]));
    const desired: IdentityProviderMapperRepresentation[] = oidcMappers(source, view.roleMappings, tenantId);
    for (const mapper of desired) {
      const id = current.get(mapper.name);
      if (id === undefined) await this.keycloak.call('POST', path + '/mappers', mapper);
      else await this.keycloak.call('PUT', path + '/mappers/' + encodeURIComponent(id), { ...mapper, id });
    }
    const keep = new Set(desired.map((m) => m.name));
    for (const [name, id] of current)
      if (name.startsWith(IDENTITY_FEDERATION.objectPrefix) && !keep.has(name)) await this.keycloak.call('DELETE', path + '/mappers/' + encodeURIComponent(id));
    const internal = z.object({ internalId: z.string().min(1) }).parse((await this.keycloak.call('GET', path)).body);
    return internal.internalId;
  }

  /** Keycloak's LDAP connection-and-bind test, or its read of the provider's discovery document; recorded on the source. */
  async test(actor: Actor, id: string): Promise<IdentitySourceTestView> {
    const row = await this.row(actor.tenantId, id);
    const view = this.view(row);
    assertVendorAllowed(view.vendor, this.env.DEPLOY_PROFILE);
    return withSpan(TRACER_NAME, 'identity.source.test', { 'openmap.tenant': actor.tenantId, 'identity.kind': view.kind, 'identity.vendor': view.vendor }, async () => {
      let ok = false;
      let message: string;
      try {
        message = view.ldap !== null ? await this.testLdap(row, view.ldap) : await this.testOidc(view);
        ok = true;
      } catch (err) {
        message = errorText(err);
      }
      const at = new Date();
      await this.prisma.client.identitySource.update({ where: { id: row.id }, data: { lastTestAt: at, lastTestOk: ok, lastTestMessage: message } });
      this.metrics.identitySourceOps.inc({ op: 'test', kind: view.kind, outcome: ok ? 'ok' : 'error' });
      return { ok, message, at };
    });
  }

  private async testLdap(row: Row, settings: LdapSourceSettings): Promise<string> {
    const body = {
      action: 'testAuthentication',
      connectionUrl: settings.connectionUrl,
      bindDn: settings.bindDn,
      bindCredential: await this.secretField(row.secretRef, 'ldap'),
      useTruststoreSpi: 'always',
      connectionTimeout: String(IDENTITY_FEDERATION.ldapConnectionTimeoutMs),
      startTls: settings.startTls ? 'true' : 'false',
      authType: 'simple',
      ...(row.keycloakId === null ? {} : { componentId: row.keycloakId }),
    };
    const res = await this.keycloak.request('POST', '/testLDAPConnection', body);
    if (!res.ok) throw new KeycloakError(res.status, 'Keycloak could not connect and bind to ' + settings.connectionUrl + ' as ' + settings.bindDn + '. ' + keycloakReason(res.status, res.body));
    return 'Keycloak connected to ' + settings.connectionUrl + ' and bound as ' + settings.bindDn;
  }

  private async testOidc(view: IdentitySourceView): Promise<string> {
    if (view.oidc === null) throw new BadRequestException('identity source ' + view.id + ' has no OpenID Connect settings');
    const endpoints = await this.discover(view.oidc.issuer);
    return 'Keycloak read the discovery document of ' + endpoints.issuer + ' (authorization ' + endpoints.authorizationUrl + ', token ' + endpoints.tokenUrl + ')';
  }

  /** Imports a directory's groups below `/<alias>`, then its users; the counts are recorded on the source. */
  async sync(actor: Actor, id: string): Promise<IdentitySourceSyncView> {
    const row = await this.row(actor.tenantId, id);
    const view = this.view(row);
    if (view.kind !== 'ldap') throw new BadRequestException('only directories sync; an OpenID Connect provider creates people at their first sign-in');
    if (row.state !== 'applied' || row.keycloakId === null) throw new BadRequestException('identity source ' + row.name + ' is not applied to Keycloak; save it again first');
    const componentId = row.keycloakId;
    return withSpan(TRACER_NAME, 'identity.source.sync', { 'openmap.tenant': actor.tenantId, 'identity.vendor': view.vendor }, async () => {
      try {
        const groupsMapper = (await this.childMappers(componentId)).find((m) => m.name === OWNED.groupsMapper);
        if (groupsMapper === undefined) throw new BadRequestException('identity source ' + row.name + ' lost its groups mapper in Keycloak; save it again');
        const storage = '/user-storage/' + encodeURIComponent(componentId);
        const options = { timeoutMs: IDENTITY_FEDERATION.syncTimeoutMs };
        const groups = syncResultSchema.parse((await this.keycloak.call('POST', storage + '/mappers/' + encodeURIComponent(groupsMapper.id) + '/sync?direction=fedToKeycloak', undefined, options)).body);
        const users = syncResultSchema.parse((await this.keycloak.call('POST', storage + '/sync?action=triggerFullSync', undefined, options)).body);
        const result = {
          added: users.added,
          updated: users.updated,
          removed: users.removed,
          failed: users.failed,
          groups: groups.added + groups.updated,
          message: [groups.status, users.status].filter((s): s is string => s !== undefined && s !== '').join('; '),
        };
        const at = new Date();
        await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
          await tx.identitySource.update({ where: { id: row.id }, data: { lastSyncAt: at, lastSync: result } });
          await emit({ type: 'openmap.audit.action', subject: row.id, data: { action: 'identity_source.synced', alias: row.alias, ...result, by: actor.username } });
        });
        this.metrics.identitySourceOps.inc({ op: 'sync', kind: 'ldap', outcome: 'ok' });
        for (const key of ['added', 'updated', 'removed', 'failed'] as const) this.metrics.identitySyncUsers.inc({ result: key }, result[key]);
        return { ...result, at };
      } catch (err) {
        this.metrics.identitySourceOps.inc({ op: 'sync', kind: 'ldap', outcome: 'error' });
        throw err;
      }
    });
  }

  /** Removes the source's objects from Keycloak (its directory users go with the component), then the source itself. */
  async remove(actor: Actor, id: string): Promise<boolean> {
    const row = await this.row(actor.tenantId, id);
    const view = this.view(row);
    return withSpan(TRACER_NAME, 'identity.source.remove', { 'openmap.tenant': actor.tenantId, 'identity.kind': view.kind }, async () => {
      try {
        const gone = [HTTP.status.noContent, HTTP.status.ok, HTTP.status.notFound];
        if (view.kind === 'ldap') {
          const componentId = await this.component(row.keycloakId, await this.realmId(), row.alias);
          if (componentId !== null) await this.keycloak.call('DELETE', '/components/' + encodeURIComponent(componentId), undefined, { expect: gone });
          const parentId = await this.parentGroup(row.alias);
          if (parentId !== null) await this.keycloak.call('DELETE', '/groups/' + encodeURIComponent(parentId), undefined, { expect: gone });
        } else {
          await this.keycloak.call('DELETE', '/identity-provider/instances/' + encodeURIComponent(row.alias), undefined, { expect: gone });
        }
      } catch (err) {
        this.metrics.identitySourceOps.inc({ op: 'remove', kind: view.kind, outcome: 'error' });
        throw err;
      }
      await this.outbox.transaction(actor.tenantId, async ({ tx, emit }) => {
        await tx.identitySource.delete({ where: { id: row.id } });
        await emit({ type: 'openmap.audit.action', subject: row.id, data: { action: 'identity_source.removed', vendor: row.vendor, name: row.name, alias: row.alias, by: actor.username } });
      });
      this.metrics.identitySourceOps.inc({ op: 'remove', kind: view.kind, outcome: 'ok' });
      return true;
    });
  }
}
