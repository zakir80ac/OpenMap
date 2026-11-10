// REQ-SEC-011 (ADR-068) — makes every TLS client of the process trust the internal services CA. The stores (PostgreSQL,
// ClickHouse, Memgraph, Valkey, Meilisearch, OpenBao) serve certificates from that CA; adding it to Node's default CA
// set covers every client that does not name its own CA: fetch (Meilisearch, OpenBao, Superset), ioredis over
// rediss://, neo4j-driver over bolt+s://. The system CAs stay trusted. Called by loadEnv, so a process that reads its
// configuration trusts the CA before it opens a connection.
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

export interface CaTrust {
  read(path: string): string;
  defaults(): string[];
  setDefaults(certs: string[]): void;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

const nodeTrust: CaTrust = {
  read: (path) => readFileSync(path, 'utf8'),
  defaults: () => tls.getCACertificates('default'),
  setDefaults: (certs) => {
    tls.setDefaultCACertificates(certs);
  },
};

const trusted = new Set<string>();

/** The certificates in a PEM bundle, one string each. */
export function pemCertificates(bundle: string): string[] {
  return bundle.match(PEM_BLOCK) ?? [];
}

/**
 * Adds the CA bundle at `path` to the default CA set, once per path and process. Returns the number of certificates
 * added (0 when `path` is unset or was already added). A path that names no certificate is an error: the clients would
 * fail later, against every store, with a less useful message.
 */
export function trustServiceCa(path: string | undefined, trust: CaTrust = nodeTrust): number {
  if (path === undefined || trusted.has(path)) return 0;
  const certs = pemCertificates(trust.read(path));
  if (certs.length === 0) throw new Error('SERVICE_CA_PATH names no PEM certificate: ' + path);
  const current = trust.defaults();
  const added = certs.filter((c) => !current.includes(c));
  trust.setDefaults([...current, ...added]);
  trusted.add(path);
  return added.length;
}
