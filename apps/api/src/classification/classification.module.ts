// REQ-AI-002 (ADR-052) — classification of unknown CIs.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ClassificationResolver, ClassificationSuggestionFieldsResolver } from './classification.resolver.js';
import { ClassificationService } from './classification.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [ClassificationService, ClassificationResolver, ClassificationSuggestionFieldsResolver],
})
export class ClassificationModule {}
