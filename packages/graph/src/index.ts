// REQ-CORE-011 — graph package entry point.
import { loadEnv, type Env } from '@openmap/config';
import { BoltGraphRepository, type GraphEngine } from './bolt-repository.js';
import type { GraphRepository } from './types.js';

export * from './types.js';
export * from './cypher.js';
export { BoltGraphRepository } from './bolt-repository.js';
export type { GraphEngine, BoltRepositoryOptions } from './bolt-repository.js';

/** Builds the repository from validated environment: Memgraph by default, Neo4j when GRAPH_ENGINE says so. */
export function createGraphRepository(env: Env = loadEnv(), engine: GraphEngine = 'memgraph'): GraphRepository {
  return new BoltGraphRepository({ url: env.MEMGRAPH_URL, user: env.MEMGRAPH_USER, password: env.MEMGRAPH_PASSWORD, engine });
}
