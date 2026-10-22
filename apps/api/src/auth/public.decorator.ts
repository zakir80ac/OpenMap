// REQ-CORE-012 — marks a handler as reachable without a token (liveness and readiness probes only).
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'openmap:public';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
