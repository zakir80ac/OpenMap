// REQ-CORE-012 — bearer token verification: RS256 signature against the realm key set, issuer and
// client checks, then the tenant claim and realm roles become the Principal.
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.module.js';
import { JWKS, realmUrl, type KeyResolver } from './jwks.provider.js';
import type { Principal } from './principal.js';
import { TenantDirectory } from './tenant-directory.js';

const claimsSchema = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().min(1).optional(),
  /** Tenant id (UUID) or tenant slug, resolved through TenantDirectory. */
  tenant: z.string().min(1),
  /** Keycloak's default realm-role claim and the flat `roles` claim the realm import maps. */
  realm_access: z.object({ roles: z.array(z.string()) }).optional(),
  roles: z.array(z.string()).optional(),
  azp: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
});

const BEARER = 'Bearer ';
export const SIGNING_ALGORITHM = 'RS256';

@Injectable()
export class AuthService {
  private readonly issuer: string;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JWKS) private readonly keys: KeyResolver,
    private readonly tenants: TenantDirectory,
  ) {
    this.issuer = realmUrl(env).toString();
  }

  /** Verifies an Authorization header; null when absent so the guard can decide what is public. */
  async verifyHeader(header: string | undefined): Promise<Principal | null> {
    if (header === undefined || header.length === 0) return null;
    if (!header.startsWith(BEARER)) throw new UnauthorizedException('authorization scheme must be Bearer');
    return this.verifyToken(header.slice(BEARER.length).trim());
  }

  async verifyToken(token: string): Promise<Principal> {
    let payload: unknown;
    try {
      const result = await jwtVerify(token, this.keys, { issuer: this.issuer, algorithms: [SIGNING_ALGORITHM] });
      payload = result.payload;
    } catch (err) {
      throw new UnauthorizedException(err instanceof Error ? err.message : 'token verification failed');
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw new UnauthorizedException('token lacks required claims (sub, tenant)');
    const c = claims.data;
    // Browser sessions are issued for the console client (`azp`); automation tokens from the client-credentials
    // grant are addressed to the API's own client in `aud` (REQ-SEC-009). Anything else is a foreign token.
    const audiences = typeof c.aud === 'string' ? [c.aud] : (c.aud ?? []);
    const forConsole = c.azp === this.env.KEYCLOAK_CLIENT_ID || audiences.includes(this.env.KEYCLOAK_CLIENT_ID);
    const forApi = audiences.includes(this.env.KEYCLOAK_API_CLIENT_ID);
    if (!forConsole && !forApi) {
      throw new UnauthorizedException('token was not issued for this client');
    }
    const tenantId = await this.tenants.resolve(c.tenant);
    const roles = [...new Set([...(c.realm_access?.roles ?? []), ...(c.roles ?? [])])];
    return { subject: c.sub, username: c.preferred_username ?? c.sub, tenantId, roles };
  }
}
