// REQ-CORE-003 — validated environment configuration. This is the only module in the
// repository that reads process.env. Every default below is documented and is the value
// that `docker compose up` in deploy/compose produces.
import { z } from 'zod';
import { LOCALES, RECONCILER } from '@openmap/constants';
import { trustServiceCa } from './service-ca.js';

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
  /**
   * REQ-SEC-011 (ADR-068): the internal services CA's certificate, which every TLS client (ClickHouse, Memgraph, Valkey,
   * Meilisearch, OpenBao) verifies its server against. Unset: the system trust store.
   */
  SERVICE_CA_PATH: z.string().min(1).optional(),
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
   * Keycloak's bootstrap administrator (the compose .env names them KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD). Only
   * dev and CI tooling uses them (tools/perf creates its load-test user); the services never do. Empty disables it.
   */
  KEYCLOAK_ADMIN: z.string().default(''),
  KEYCLOAK_ADMIN_PASSWORD: z.string().default(''),
  /**
   * The API's own (bearer-only) client in the realm. Tokens minted for automation through the client-credentials
   * grant (REQ-SEC-009) carry it in `aud`, so the API accepts them without being issued for the console client.
   */
  KEYCLOAK_API_CLIENT_ID: z.string().default('openmap-api'),
  /** OpenBao: secrets for collector credentials. */
  OPENBAO_ADDR: url.default('http://localhost:8200'),
  /**
   * REQ-SEC-011 (ADR-067): services log in with AppRole (role id and secret id read from these files, written by the
   * openbao-init job) and renew by logging in again. OPENBAO_TOKEN is for an operator or a host-side test, or an
   * external vault that issues a token; unset in the services.
   */
  OPENBAO_TOKEN: z.string().min(1).optional(),
  OPENBAO_ROLE_ID_FILE: z.string().min(1).optional(),
  OPENBAO_SECRET_ID_FILE: z.string().min(1).optional(),
  OPENBAO_APPROLE_MOUNT: z.string().default('approle'),
  OPENBAO_MOUNT: z.string().default('openmap'),
  /** Superset: embedded analytics. */
  SUPERSET_URL: url.default('http://localhost:8088'),
  /** Superset origin the browser loads the embedded dashboard from; SUPERSET_URL is the backchannel. */
  PUBLIC_SUPERSET_URL: url.default('http://localhost:8088'),
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
  /** REQ-CORE-020 — concurrent outbox dispatch loops per reconciler; claims are leased, so loops and replicas never share a row. */
  RECONCILER_DISPATCHERS: z.coerce.number().int().positive().default(RECONCILER.outboxDispatchers),
  SCHEDULER_PORT: port.default(4200),
  /** Plain-HTTP listener for the scheduler's /metrics, /healthz and /readyz; the Node API itself is mTLS on SCHEDULER_PORT. */
  SCHEDULER_METRICS_PORT: port.default(4201),
  ASSISTANT_PORT: port.default(4300),
  BSM_ENGINE_PORT: port.default(4400),
  /** Public origins, used for OIDC redirects and CORS. */
  PUBLIC_CONSOLE_URL: url.default('http://localhost:3000'),
  /**
   * A second address the same console is opened at (a loopback IP beside `localhost`, or a host name beside an IP).
   * The console signs in from whichever origin it was opened on, so Keycloak's redirect URIs and the API's CORS
   * must accept both. Unset: only PUBLIC_CONSOLE_URL.
   */
  PUBLIC_CONSOLE_ALIAS_URL: url.optional(),
  /** REQ-CMDB-023 (ADR-039): the product lifecycle catalogue the snapshot and the optional tenant-enabled sync read. */
  LIFECYCLE_CATALOGUE_URL: url.default('https://endoflife.date/api'),
  /**
   * REQ-CMDB-024 (ADR-043): vendor support APIs the warranty collector asks, from the Discovery Node, only for the
   * vendors a tenant has stored credentials for. Overridable for regional gateways and simulated mode.
   */
  WARRANTY_DELL_API_URL: url.default('https://apigtwb2c.us.dell.com'),
  WARRANTY_DELL_TOKEN_URL: url.default('https://apigtwb2c.us.dell.com/auth/oauth/v2/token'),
  WARRANTY_LENOVO_API_URL: url.default('https://supportapi.lenovo.com'),
  WARRANTY_CISCO_API_URL: url.default('https://apix.cisco.com'),
  WARRANTY_CISCO_TOKEN_URL: url.default('https://id.cisco.com/oauth2/default/v1/token'),
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
  /** REQ-INT-019 (ADR-066): where backup sets are (the API reads their manifests); unset when this deployment keeps none. */
  BACKUP_DIR: z.string().min(1).optional(),

  /** Feature switches. */
  FEATURE_OUTBOUND_INTEGRATIONS: bool.default(false),
  FEATURE_ASSISTANT: bool.default(true),
  /**
   * ADR-028: let the model write the prose of an answer (under the grounding guard). Off, every answer is the
   * deterministic summary; useful on a CPU profile where the small model adds seconds and little wording.
   */
  ASSISTANT_PROSE: bool.default(true),
  /** Locales the model may reword in (comma-separated); the CPU profile's small model is trusted with English only. */
  ASSISTANT_PROSE_LOCALES: z.string().default('en,ar'),
  /**
   * REQ-BSM-004 (ADR-047): how often the API compares newly resolved incidents with a simulation of their root
   * cause. 0 turns the sweep off; validateImpactPredictions still runs it on demand.
   */
  IMPACT_VALIDATION_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  /** REQ-BSM-007 (ADR-025): how often the scheduler plans a probe of every inter-site link. 0 turns probing off. */
  LINK_PROBE_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  /** REQ-AI-003 (ADR-053): how often the API evaluates the anomaly rules for every tenant; 0 turns the sweep off. */
  ANOMALY_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
  /** REQ-IPAM-003 (ADR-055): the scheduler's DNS sync round (pending changes are pushed on the next round); 0 turns it off. */
  DNS_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /** REQ-IPAM-003: how often a zone kept in sync is transferred when no change is waiting. */
  DNS_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
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

/**
 * Parse and validate the environment. Throws ConfigError on the first invalid variable. With SERVICE_CA_PATH set, the
 * process's TLS clients trust the internal services CA from here on (ADR-068).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) throw new ConfigError(parsed.error.issues);
  trustServiceCa(parsed.data.SERVICE_CA_PATH);
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
