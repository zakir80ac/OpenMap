// REQ-SEC-012 (ADR-070) — compliance posture bounded context. It reads the lifecycle catalogue, the certificate
// register and the backup manifests through those contexts' services (provided here; they hold no state) and the
// other facts through its own repository.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BackupsModule } from '../backups/backups.module.js';
import { CertificatesService } from '../certificates/certificates.service.js';
import { CiModule } from '../ci/ci.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ComplianceFactsRepository } from './compliance.facts.js';
import { ComplianceFindingFieldsResolver, ComplianceResolver } from './compliance.resolver.js';
import { ComplianceService } from './compliance.service.js';

@Module({
  imports: [CiModule, MetricsModule, BackupsModule, IntegrationsModule, AuditModule],
  providers: [ComplianceFactsRepository, LifecycleService, CertificatesService, ComplianceService, ComplianceResolver, ComplianceFindingFieldsResolver],
  exports: [ComplianceService],
})
export class ComplianceModule {}
