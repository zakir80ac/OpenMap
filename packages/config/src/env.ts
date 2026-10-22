// REQ-CORE-003 — validated environment configuration. This is the only module in the
// repository that reads process.env. Every default below is documented and is the value
// that `docker compose up` in deploy/compose produces.
import { z } from 'zod';
import { LOCALES } from '@openmap/constants';

const url = z.url();
const port = z.coerce.number().int().min(1).max(65535);
const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const envSchema = z.object({
  /** Runtime mode. 'test' is set by the compose test harness. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Log verbosity for every service (pino / slog levels). */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Default UI locale for tenants that have not chosen one. */
  DEFAULT_LOCALE: z.enum(LOCALES).default('en'),
  /** Deployment profile; 'airgap' disables every optional outbound integration. */
  DEPLOY_PROFILE: z.enum(['single-node', 'airgap', 'helm']).default('single-node'),

  /** Postgres: system of record (CMDB, IPAM, DCIM, BSM definitions, tenants, outbox). */
  POSTGRES_URL: url.default('postgresql://openmap:openmap@localhost:5432/openmap'),
  /** Memgraph: dependency graph; Bolt protocol. */
  MEMGRAPH_URL: z.string().default('bolt://localhost:7687'),
  MEMGRAPH_USER: z.string().default(''),
  MEMGRAPH_PASSWORD: z.string().default(''),
  /** ClickHouse: time-series, time-travel snapshots, analytics source for Superset. */
  CLICKHOUSE_URL: url.default('http://localhost:8123'),
  CLICKHOUSE_DB: z.string().default('openmap'),
  CLICKHOUSE_USER: z.string().default('openmap'),
  CLICKHOUSE_PASSWORD: z.string().default('openmap'),
  /** Valkey: BullMQ queues, caches, rate limiting. */
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  /** Meilisearch: global search over CIs. */
  MEILI_URL: url.default('http://localhost:7700'),
  MEILI_MASTER_KEY: z.string().default('openmap-dev-master-key'),
  /** Keycloak: OIDC identity provider. */
  KEYCLOAK_URL: url.default('http://localhost:8080'),
  KEYCLOAK_REALM: z.string().default('openmap'),
  KEYCLOAK_CLIENT_ID: z.string().default('openmap-console'),
  /**
   * The API's own (bearer-only) client in the realm. Tokens minted for automation through the client-credentials
   * grant (REQ-SEC-009) carry it in `aud`, so the API accepts them without being issued for the console client.
   */
  KEYCLOAK_API_CLIENT_ID: z.string().default('openmap-api'),
  /** OpenBao: secrets for collector credentials. */
  OPENBAO_ADDR: url.default('http://localhost:8200'),
  OPENBAO_TOKEN: z.string().default('openmap-dev-root'),
  OPENBAO_MOUNT: z.string().default('openmap'),
  /** Superset: embedded analytics. */
  SUPERSET_URL: url.default('http://localhost:8088'),
  SUPERSET_ADMIN_USER: z.string().default('admin'),
  SUPERSET_ADMIN_PASSWORD: z.string().default('admin'),
  /** LLM endpoint (OpenAI-compatible): vLLM on GPU, llama.cpp server as the CPU fallback. */
  LLM_BASE_URL: url.default('http://localhost:8000/v1'),
  LLM_MODEL: z.string().default('Qwen/Qwen2.5-7B-Instruct'),
  LLM_API_KEY: z.string().default('local'),
  /** Request timeout for LLM calls; NL-to-Cypher on CPU can take tens of seconds. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /** Service listen ports. */
  API_PORT: port.default(4000),
  CONSOLE_PORT: port.default(3000),
  RECONCILER_PORT: port.default(4100),
  SCHEDULER_PORT: port.default(4200),
  ASSISTANT_PORT: port.default(4300),
  BSM_ENGINE_PORT: port.default(4400),
  /** Public origins, used for OIDC redirects and CORS. */
  PUBLIC_CONSOLE_URL: url.default('http://localhost:3000'),
  PUBLIC_API_URL: url.default('http://localhost:4000'),
  /**
   * Keycloak as the browser reaches it. The console's OIDC flow (discovery, authorize, token, end_session) runs
   * against this origin, so the `iss` claim Keycloak writes into tokens is derived from it; the API must verify
   * against the same issuer (KC_HOSTNAME in deploy/compose pins it to this value).
   */
  PUBLIC_KEYCLOAK_URL: url.default('http://localhost:8080'),
  /** Origin Discovery Nodes reach the scheduler on; its hostname becomes the scheduler certificate's subject. */
  PUBLIC_SCHEDULER_URL: url.default('https://localhost:4200'),
  /** Extra DNS names for the scheduler certificate (comma-separated), e.g. the compose or cluster service name. */
  SCHEDULER_TLS_EXTRA_SANS: z.string().default(''),

  /** OpenTelemetry collector endpoint; empty disables export (spans still recorded in-process). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  /** Prometheus scrape endpoint path for every Node service. */
  METRICS_PATH: z.string().default('/metrics'),

  /** Discovery Node mTLS material. */
  NODE_MTLS_CA_PATH: z.string().default('/etc/openmap/pki/ca.crt'),
  NODE_MTLS_CERT_PATH: z.string().default('/etc/openmap/pki/node.crt'),
  NODE_MTLS_KEY_PATH: z.string().default('/etc/openmap/pki/node.key'),
  /** Interval at which a Discovery Node pulls jobs from the scheduler. */
  NODE_JOB_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Scheduler-side PKI: the internal CA that signs Node certificates, and the scheduler's own TLS pair. */
  SCHEDULER_CA_CERT_PATH: z.string().default('/etc/openmap/pki/ca.crt'),
  SCHEDULER_CA_KEY_PATH: z.string().default('/etc/openmap/pki/ca.key'),
  SCHEDULER_TLS_CERT_PATH: z.string().default('/etc/openmap/pki/scheduler.crt'),
  SCHEDULER_TLS_KEY_PATH: z.string().default('/etc/openmap/pki/scheduler.key'),
  /** Validity of issued Node certificates; Nodes re-enrol before expiry. */
  NODE_CERT_VALIDITY_DAYS: z.coerce.number().int().positive().default(90),
  /** Where the scheduler keeps raw evidence uploaded by Nodes (content-addressed). */
  EVIDENCE_DIR: z.string().default('/var/lib/openmap/evidence'),

  /** Feature switches. */
  FEATURE_OUTBOUND_INTEGRATIONS: bool.default(false),
  FEATURE_ASSISTANT: bool.default(true),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodError['issues']) {
    super(
      'Invalid environment configuration: ' +
        issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
    );
    this.name = 'ConfigError';
  }
}

/** Parse and validate the environment. Throws ConfigError on the first invalid variable. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) throw new ConfigError(parsed.error.issues);
  return parsed.data;
}

/** Documentation of every variable with its default, for deploy/compose/.env.example and docs. */
export function describeEnv(): Array<{ name: string; defaultValue: string }> {
  const defaults = envSchema.parse({}) as Record<string, unknown>;
  return Object.keys(envSchema.shape).map((name) => ({
    name,
    defaultValue: String(defaults[name] ?? ''),
  }));
}
