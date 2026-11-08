// REQ-AI-005 (ADR-054) — cloud recommendations over utilisation and cost.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { CloudAdviceResolver, CloudRecommendationFieldsResolver } from './cloud-advice.resolver.js';
import { CloudAdviceService } from './cloud-advice.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [CloudAdviceService, CloudAdviceResolver, CloudRecommendationFieldsResolver],
})
export class CloudAdviceModule {}
