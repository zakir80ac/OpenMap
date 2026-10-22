// REQ-CORE-012 — validated environment as an injectable. loadEnv() is the only process.env reader.
import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from '@openmap/config';

export const ENV = Symbol('ENV');
export type { Env };

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}
