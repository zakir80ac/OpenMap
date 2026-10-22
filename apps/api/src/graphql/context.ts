// REQ-CORE-012 — GraphQL request context: the verified principal (or why verification failed), a
// request id for provenance and tracing, and the per-request batch loaders.
import type { Principal } from '../auth/principal.js';
import type { CiLoaders } from '../ci/ci.loaders.js';

export interface GqlContext {
  principal: Principal | null;
  /** Verification failure message when a token was presented but rejected; the guard reports it. */
  authError: string | null;
  requestId: string;
  loaders: CiLoaders | null;
}

/** GraphQL endpoint path; part of the frozen contract (docs/CONTRACTS.md) rather than deployment config. */
export const GRAPHQL_PATH = '/graphql';
