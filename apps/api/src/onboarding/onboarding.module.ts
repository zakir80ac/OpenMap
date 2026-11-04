// REQ-UI-024 REQ-UI-020 — initial setup bounded context (ADR-017).
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { OnboardingRepository } from './onboarding.repository.js';
import { OnboardingResolver, OnboardingStateFieldsResolver, SiteFieldsResolver, SiteLinkFieldsResolver } from './onboarding.resolver.js';
import { OnboardingService } from './onboarding.service.js';

@Module({
  imports: [CiModule, DiscoveryModule, IntegrationsModule],
  providers: [OnboardingRepository, OnboardingService, OnboardingResolver, OnboardingStateFieldsResolver, SiteFieldsResolver, SiteLinkFieldsResolver],
  exports: [OnboardingService],
})
export class OnboardingModule {}
