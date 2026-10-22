// T-023 REQ-DISC-028 — route behaviour with an in-memory job store and a header-supplied peer certificate.
import type { PeerCertificate } from 'node:tls';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import type { CollectorJob, CollectorResult } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import { buildApp, tokenDigest } from './app.js';
import type { JobStore } from './jobs.js';
import { generateCa, loadCa } from './pki.js';
import type { ResultsQueue } from './results-queue.js';
import type { SecretsReader } from './secrets.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const jobId = '1b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const siteId = '2b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const now = new Date().toISOString();

function peer(cn: string, validTo = new Date(Date.now() + 86_400_000).toUTCString()): PeerCertificate {
  return { subject: { CN: cn }, valid_to: validTo } as unknown as PeerCertificate;
}

async function csr(cn: string, ou: string): Promise<string> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return (await x509.Pkcs10CertificateRequestGenerator.create({ name: 'CN=' + cn + ', OU=' + ou, keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })).toString('pem');
}

interface NodeRow { id: string; status: string; enrolTokenDigest: string | null; site: { code: string } }

async function harness() {
  const caPems = await generateCa('test', 1);
  const ca = await loadCa(caPems.certPem, caPems.keyPem);
  const nodes = new Map<string, NodeRow>([
    ['node-ryd-01', { id: 'node-ryd-01', status: 'pending', enrolTokenDigest: tokenDigest('secret-token'), site: { code: 'RYD' } }],
    ['node-ryd-02', { id: 'node-ryd-02', status: 'enrolled', enrolTokenDigest: null, site: { code: 'RYD' } }],
  ]);
  const jobsTable = new Map<string, { id: string; nodeId: string; status: string; credentialRef: string | null }>([[jobId, { id: jobId, nodeId: 'node-ryd-02', status: 'started', credentialRef: 'creds/snmp' }]]);
  const prisma = {
    discoveryNode: {
      findUnique: async ({ where }: { where: { id: string } }) => nodes.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<NodeRow> }) => { const n = nodes.get(where.id)!; Object.assign(n, data); return n; },
    },
    discoveryJob: { findUnique: async ({ where }: { where: { id: string } }) => jobsTable.get(where.id) ?? null },
  } as unknown as PrismaClient;
  const pulled: CollectorJob[] = [];
  const jobs: JobStore = {
    schedule: async (j) => j.length,
    pull: async (nodeId, capacity) => pulled.filter((j) => j.nodeId === nodeId).slice(0, capacity),
    complete: async (r) => ({ runId: r.runId }),
  };
  const published: CollectorResult[] = [];
  const results: ResultsQueue = { publish: async (r) => { published.push(r); return r.runId; }, close: async () => undefined };
  const secrets: SecretsReader = { read: async (ref) => ({ type: 'snmp_v3', fields: { ref }, expiresAt: null }) };
  let currentPeer: PeerCertificate | null = null;
  const app = buildApp({ env: { NODE_CERT_VALIDITY_DAYS: 1 }, prisma, jobs, results, secrets, ca, caPem: caPems.certPem, peerCertificateFromSocket: () => currentPeer });
  return { app, nodes, published, setPeer: (p: PeerCertificate | null) => { currentPeer = p; } };
}

describe('scheduler node api', () => {
  it('enrols a pending node with the right token and site, then refuses a replay', async () => {
    const h = await harness();
    const good = await h.app.inject({ method: 'POST', url: '/v1/nodes/enrol', payload: { nodeId: 'node-ryd-01', siteCode: 'RYD', token: 'secret-token', csrPem: await csr('node-ryd-01', 'RYD') } });
    expect(good.statusCode).toBe(201);
    expect(good.json<{ certificatePem: string }>().certificatePem).toContain('BEGIN CERTIFICATE');
    expect(h.nodes.get('node-ryd-01')?.status).toBe('enrolled');
    const replay = await h.app.inject({ method: 'POST', url: '/v1/nodes/enrol', payload: { nodeId: 'node-ryd-01', siteCode: 'RYD', token: 'secret-token', csrPem: await csr('node-ryd-01', 'RYD') } });
    expect(replay.statusCode).toBe(403);
  });
  it('rejects a wrong token or site code', async () => {
    const h = await harness();
    const wrongToken = await h.app.inject({ method: 'POST', url: '/v1/nodes/enrol', payload: { nodeId: 'node-ryd-01', siteCode: 'RYD', token: 'nope', csrPem: await csr('node-ryd-01', 'RYD') } });
    expect(wrongToken.statusCode).toBe(403);
    const wrongSite = await h.app.inject({ method: 'POST', url: '/v1/nodes/enrol', payload: { nodeId: 'node-ryd-01', siteCode: 'JED', token: 'secret-token', csrPem: await csr('node-ryd-01', 'JED') } });
    expect(wrongSite.statusCode).toBe(403);
  });
  it('requires a matching, valid peer certificate on node routes', async () => {
    const h = await harness();
    h.setPeer(null);
    expect((await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/jobs/pull', payload: { capacity: 1, collectors: [] } })).statusCode).toBe(401);
    h.setPeer(peer('node-other'));
    expect((await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/jobs/pull', payload: { capacity: 1, collectors: [] } })).statusCode).toBe(401);
    h.setPeer(peer('node-ryd-02', new Date(Date.now() - 1000).toUTCString()));
    expect((await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/jobs/pull', payload: { capacity: 1, collectors: [] } })).statusCode).toBe(401);
    h.setPeer(peer('node-ryd-02'));
    const ok = await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/jobs/pull', payload: { capacity: 2, collectors: ['snmp'] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ jobs: unknown[] }>().jobs).toEqual([]);
  });
  it('accepts a valid result for the node that owns the job and publishes it', async () => {
    const h = await harness();
    h.setPeer(peer('node-ryd-02'));
    const result: CollectorResult = {
      jobId, runId: siteId, tenantId, collectorId: 'snmp', nodeId: 'node-ryd-02', status: 'success', startedAt: now, finishedAt: now,
      cis: [], relationships: [], evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 5 }, contractVersion: '0.1.0',
    };
    const res = await h.app.inject({ method: 'POST', url: '/v1/jobs/' + jobId + '/result', payload: result });
    expect(res.statusCode).toBe(202);
    expect(h.published).toHaveLength(1);
    const mismatch = await h.app.inject({ method: 'POST', url: '/v1/jobs/' + siteId + '/result', payload: result });
    expect(mismatch.statusCode).toBe(400);
  });
  it('resolves a credential only for a running job assigned to the node', async () => {
    const h = await harness();
    h.setPeer(peer('node-ryd-02'));
    const ok = await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/credentials/resolve', payload: { credentialRef: 'creds/snmp', jobId } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ type: string }>().type).toBe('snmp_v3');
    const wrongRef = await h.app.inject({ method: 'POST', url: '/v1/nodes/node-ryd-02/credentials/resolve', payload: { credentialRef: 'creds/other', jobId } });
    expect(wrongRef.statusCode).toBe(403);
  });
});
