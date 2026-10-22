// REQ-CORE-012 — declares the realm roles a resolver requires; enforced by RolesGuard.
import { SetMetadata } from '@nestjs/common';
import type { Role } from './roles.js';

export const REQUIRED_ROLES = 'openmap:roles';

export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ROLES, roles);
