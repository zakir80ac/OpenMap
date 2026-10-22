// REQ-CORE-012 — custom scalars for the frozen GraphQL contract.
import { Module } from '@nestjs/common';
import { DateTimeScalar } from './datetime.scalar.js';
import { JsonScalar } from './json.scalar.js';
import { UuidScalar } from './uuid.scalar.js';

@Module({ providers: [DateTimeScalar, JsonScalar, UuidScalar] })
export class ScalarsModule {}
