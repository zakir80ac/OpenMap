// REQ-UI-024 REQ-UI-020 — GraphQL surface of the initial setup (ADR-017): `onboarding` for every signed-in role, the
// setup mutations for administrators. Field resolvers assemble the state from the organization, discovery and
// integrations services so one query drives the whole wizard.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { Actor } from '../ci/ci.service.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import type { DiscoveryNodeView, DiscoveryScopeView, SweepView } from '../discovery/discovery.types.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { IntegrationView } from '../integrations/integrations.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { credentialSetInputSchema, onboardingStepArgsSchema, organizationInputSchema, registerNodeArgsSchema, scopeInputSchema, siteInputSchema, siteLinkInputSchema } from './onboarding.schemas.js';
import { OnboardingService } from './onboarding.service.js';
import type { CredentialSetView, NodeRegistrationView, OnboardingStateView, OrganizationView, SiteLinkView, SiteView } from './onboarding.types.js';

const idArg = z.object({ id: z.uuid() });
const optionalIdArg = z.object({ id: z.uuid().nullish() });

@Resolver()
export class OnboardingResolver {
  constructor(
    private readonly service: OnboardingService,
    private readonly tenant: TenantContext,
  ) {}

  private get actor(): Actor {
    return { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId };
  }

  @Query('onboarding')
  onboarding(): Promise<OnboardingStateView> {
    return this.service.state(this.tenant.tenantId);
  }

  @Mutation('updateOrganization')
  @Roles(ROLES.admin)
  updateOrganization(@Args('input') input: unknown): Promise<OrganizationView> {
    return this.service.updateOrganization(this.actor, parseInput(organizationInputSchema, input, 'OrganizationInput'));
  }

  @Mutation('upsertSite')
  @Roles(ROLES.admin)
  upsertSite(@Args('id') id: unknown, @Args('input') input: unknown): Promise<SiteView> {
    const { id: siteId } = parseInput(optionalIdArg, { id }, 'upsertSite arguments');
    return this.service.upsertSite(this.actor, siteId ?? null, parseInput(siteInputSchema, input, 'SiteInput'));
  }

  @Mutation('removeSite')
  @Roles(ROLES.admin)
  removeSite(@Args('id') id: unknown): Promise<boolean> {
    return this.service.removeSite(this.actor, parseInput(idArg, { id }, 'removeSite arguments').id);
  }

  @Mutation('upsertSiteLink')
  @Roles(ROLES.admin)
  upsertSiteLink(@Args('id') id: unknown, @Args('input') input: unknown): Promise<SiteLinkView> {
    const { id: linkId } = parseInput(optionalIdArg, { id }, 'upsertSiteLink arguments');
    return this.service.upsertSiteLink(this.actor, linkId ?? null, parseInput(siteLinkInputSchema, input, 'SiteLinkInput'));
  }

  @Mutation('removeSiteLink')
  @Roles(ROLES.admin)
  removeSiteLink(@Args('id') id: unknown): Promise<boolean> {
    return this.service.removeSiteLink(this.actor, parseInput(idArg, { id }, 'removeSiteLink arguments').id);
  }

  @Mutation('registerNode')
  @Roles(ROLES.admin)
  registerNode(@Args('siteId') siteId: unknown, @Args('nodeId') nodeId: unknown): Promise<NodeRegistrationView> {
    const args = parseInput(registerNodeArgsSchema, { siteId, nodeId }, 'registerNode arguments');
    return this.service.registerNode(this.actor, args.siteId, args.nodeId);
  }

  @Mutation('saveCredentialSet')
  @Roles(ROLES.admin)
  saveCredentialSet(@Args('input') input: unknown): Promise<CredentialSetView> {
    return this.service.saveCredentialSet(this.actor, parseInput(credentialSetInputSchema, input, 'CredentialSetInput'));
  }

  @Mutation('addDiscoveryScope')
  @Roles(ROLES.admin)
  addDiscoveryScope(@Args('input') input: unknown): Promise<DiscoveryScopeView> {
    return this.service.addDiscoveryScope(this.actor, parseInput(scopeInputSchema, input, 'ScopeInput'));
  }

  @Mutation('setOnboardingStep')
  @Roles(ROLES.admin)
  setOnboardingStep(@Args('step') step: unknown, @Args('completed') completed: unknown): Promise<OnboardingStateView> {
    const args = parseInput(onboardingStepArgsSchema, { step, completed }, 'setOnboardingStep arguments');
    return this.service.setStep(this.actor, args.step, args.completed);
  }

  @Mutation('generateTwin')
  @Roles(ROLES.admin)
  generateTwin(): Promise<OnboardingStateView> {
    return this.service.generateTwin(this.actor);
  }
}

@Resolver('OnboardingState')
export class OnboardingStateFieldsResolver {
  constructor(
    private readonly service: OnboardingService,
    private readonly discovery: DiscoveryService,
    private readonly integrationsService: IntegrationsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('sites')
  sites(@Parent() state: OnboardingStateView): Promise<SiteView[]> {
    return this.service.sites(state.organization.id);
  }

  @ResolveField('links')
  links(@Parent() state: OnboardingStateView): Promise<SiteLinkView[]> {
    return this.service.links(state.organization.id);
  }

  @ResolveField('nodes')
  nodes(): Promise<DiscoveryNodeView[]> {
    return this.discovery.nodes(this.tenant.tenantId);
  }

  @ResolveField('credentials')
  credentials(@Parent() state: OnboardingStateView): Promise<CredentialSetView[]> {
    return this.service.credentials(state.credentialRefs);
  }

  @ResolveField('scopes')
  scopes(): Promise<DiscoveryScopeView[]> {
    return this.discovery.scopes(this.tenant.tenantId, null);
  }

  @ResolveField('integrations')
  integrations(): Promise<IntegrationView[]> {
    return this.integrationsService.list(this.tenant.tenantId, null);
  }

  @ResolveField('firstSweep')
  firstSweep(@Parent() state: OnboardingStateView): Promise<SweepView | null> {
    return state.firstSweepId === null ? Promise.resolve(null) : this.discovery.sweep(this.tenant.tenantId, state.firstSweepId);
  }
}

@Resolver('Site')
export class SiteFieldsResolver {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('ci')
  ci(@Parent() site: SiteView): Promise<CiRecord | null> {
    return site.ciId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(site.ciId);
  }

  @ResolveField('nodes')
  async nodes(@Parent() site: SiteView): Promise<DiscoveryNodeView[]> {
    return (await this.discovery.nodes(this.tenant.tenantId)).filter((n) => n.siteId === site.id);
  }
}

@Resolver('SiteLink')
export class SiteLinkFieldsResolver {
  constructor(
    private readonly service: OnboardingService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('fromSite')
  async fromSite(@Parent() link: SiteLinkView): Promise<SiteView> {
    return this.service.site(await this.organizationId(), link.fromSiteId);
  }

  @ResolveField('toSite')
  async toSite(@Parent() link: SiteLinkView): Promise<SiteView> {
    return this.service.site(await this.organizationId(), link.toSiteId);
  }

  @ResolveField('ci')
  ci(@Parent() link: SiteLinkView): Promise<CiRecord | null> {
    return link.ciId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(link.ciId);
  }

  private organizationId(): Promise<string> {
    return this.service.organizationIdOf(this.tenant.tenantId);
  }
}
