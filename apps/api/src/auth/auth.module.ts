// REQ-CORE-012 — authentication and authorisation: Keycloak JWKS verification plus global guards.
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { jwksProvider } from './jwks.provider.js';
import { RolesGuard } from './roles.guard.js';
import { TenantDirectory } from './tenant-directory.js';

@Global()
@Module({
  providers: [jwksProvider, TenantDirectory, AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: RolesGuard }],
  exports: [AuthService, TenantDirectory],
})
export class AuthModule {}
