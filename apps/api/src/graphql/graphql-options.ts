// REQ-CORE-012 — Mercurius driver options for the frozen schema: SDL loaded from the contracts package,
// bearer verification into the request context, and token-authenticated WebSocket subscriptions.
import { GRAPHQL_EXECUTION } from '@openmap/constants';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MercuriusDriverConfig } from '@nestjs/mercurius';
import type { FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/auth.service.js';
import type { CiLoaderFactory } from '../ci/ci.loaders.js';
import { GRAPHQL_PATH, type GqlContext } from './context.js';

const SCHEMA_SPECIFIER = '@openmap/contracts/graphql/schema.graphql';

export function loadSchemaSdl(): string {
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve(SCHEMA_SPECIFIER), 'utf8');
}

export async function buildContext(auth: AuthService, loaders: CiLoaderFactory, authorization: string | undefined): Promise<GqlContext> {
  const requestId = randomUUID();
  try {
    const principal = await auth.verifyHeader(authorization);
    return { principal, authError: null, requestId, loaders: principal ? loaders.create(principal.tenantId) : null };
  } catch (err) {
    return { principal: null, authError: err instanceof Error ? err.message : String(err), requestId, loaders: null };
  }
}

interface ConnectionInit {
  payload?: Record<string, unknown> | null;
}

function headerOf(init: ConnectionInit): string | undefined {
  const payload = init.payload ?? {};
  const value = payload['authorization'] ?? payload['Authorization'];
  return typeof value === 'string' ? value : undefined;
}

export function graphqlOptions(auth: AuthService, loaders: CiLoaderFactory): MercuriusDriverConfig {
  return {
    typeDefs: loadSchemaSdl(),
    path: GRAPHQL_PATH,
    graphiql: false,
    // REQ-PERF-002: compile a query with graphql-jit after its first run (large lists execute several times faster).
    jit: GRAPHQL_EXECUTION.jitAfterRuns,
    context: (request: FastifyRequest) => buildContext(auth, loaders, request.headers.authorization),
    subscription: {
      onConnect: async (init: ConnectionInit) => {
        const context = await buildContext(auth, loaders, headerOf(init));
        return context.principal === null ? false : context;
      },
    },
  };
}
