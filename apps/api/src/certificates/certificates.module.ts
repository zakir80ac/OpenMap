// REQ-CMDB-032 (ADR-036) — the certificate register bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { CertificateFieldsResolver, CertificatesResolver } from './certificates.resolver.js';
import { CertificatesService } from './certificates.service.js';

@Module({
  imports: [CiModule],
  providers: [CertificatesService, CertificatesResolver, CertificateFieldsResolver],
})
export class CertificatesModule {}
