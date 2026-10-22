// REQ-DISC-028 REQ-DISC-031 REQ-SEC-004 — the HTTP surface Discovery Nodes talk to, over mTLS:
// enrolment (one-time token → signed certificate), heartbeat, job pull, result post, credential
// resolution. Every mTLS route checks the peer certificate names the node in the path.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTRACT_VERSIONS, DISCOVERY, HTTP, PKI } from '@openmap/constants';
import { collectorResultSchema, evidenceSchema, observedCiSchema, observedRelationshipSchema } from '@openmap/contracts';
import type { Env } from '@openmap/config';
import type { PrismaClient } from '@openmap/db';
import { JobNodeMismatch, JobNotFound, type JobStore } from './jobs.js';
import { signAgentCsr, signNodeCsr, type Ca } from './pki.js';
import type { ResultsQueue } from './results-queue.js';
import type { SecretsReader } from './secrets.js';

export interface AppDeps {
  env: Pick<Env, 'NODE_CERT_VALIDITY_DAYS'>;
  prisma: PrismaClient;
  jobs: JobStore;
  results: ResultsQueue;
  secrets: SecretsReader;
  ca: Ca;
  caPem: string;
  /** In tests the peer certificate is supplied by a header instead of TLS; production never sets this. */
  peerCertificateFromSocket?: (req: FastifyRequest) => PeerCertificate | null;
}

const enrolSchema = z.object({ nodeId: z.string().min(1), siteCode: z.string().min(1), token: z.string().min(1), csrPem: z.string().min(1) });
const heartbeatSchema = z.object({
  nodeId: z.string().min(1),
  siteCode: z.string().min(1),
  version: z.string(),
  activeJobs: z.number().int().min(0),
  maxConcurrency: z.number().int().min(1),
  collectors: z.array(z.string()),
  certificateExpiresAt: z.string(),
  sentAt: z.string(),
});
const pullSchema = z.object({ capacity: z.number().int().min(0), collectors: z.array(z.string()) });
const credentialSchema = z.object({ credentialRef: z.string().min(1), jobId: z.string().uuid() });
/** REQ-DISC-004 — agent enrolment, forwarded by the agent's Discovery Node. */
const agentEnrolSchema = z.object({ agentId: z.string().min(1), token: z.string().min(1), csrPem: z.string().min(1) });
/** REQ-DISC-004 — an agent's self-report, forwarded by its Node with the fingerprint of the client certificate it presented. */
const agentReportSchema = z.object({
  agentId: z.string().min(1),
  certificateFingerprint: z.string().length(PKI.sha256HexLength),
  agentVersion: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  cis: z.array(observedCiSchema),
  relationships: z.array(observedRelationshipSchema),
  evidence: z.array(evidenceSchema),
});
/** Collector id the agent's reports are filed under; the standing job per agent carries it. */
export const AGENT_COLLECTOR_ID = 'agent';

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function peerFromTls(req: FastifyRequest): PeerCertificate | null {
  const socket = req.raw.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function') return null;
  const cert = socket.getPeerCertificate();
  return cert && Object.keys(cert).length > 0 ? cert : null;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: HTTP.maxNodeBodyBytes });
  const peerOf = deps.peerCertificateFromSocket ?? peerFromTls;

  /** Confirms the TLS peer certificate's CN equals the node id in the route and is still valid. */
  async function requireNode(req: FastifyRequest, reply: FastifyReply, nodeId: string): Promise<boolean> {
    const cert = peerOf(req);
    if (!cert || cert.subject.CN !== nodeId) {
      await reply.code(HTTP.status.unauthorized).send({ error: 'node certificate does not match ' + nodeId });
      return false;
    }
    if (new Date(cert.valid_to).getTime() < Date.now()) {
      await reply.code(HTTP.status.unauthorized).send({ error: 'node certificate expired' });
      return false;
    }
    const node = await deps.prisma.discoveryNode.findUnique({ where: { id: nodeId } });
    if (!node || node.status !== 'enrolled') {
      await reply.code(HTTP.status.forbidden).send({ error: 'node is not enrolled' });
      return false;
    }
    return true;
  }

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/nodes/enrol', async (req, reply) => {
    const body = enrolSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    const { nodeId, siteCode, token, csrPem } = body.data;
    const node = await deps.prisma.discoveryNode.findUnique({ where: { id: nodeId }, include: { site: true } });
    if (!node || node.status !== 'pending' || !node.enrolTokenDigest) return reply.code(HTTP.status.forbidden).send({ error: 'no pending enrolment for ' + nodeId });
    const presented = Buffer.from(tokenDigest(token), 'hex');
    const expected = Buffer.from(node.enrolTokenDigest, 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return reply.code(HTTP.status.forbidden).send({ error: 'enrolment token rejected' });
    if (node.site.code !== siteCode) return reply.code(HTTP.status.forbidden).send({ error: 'site code does not match the enrolment' });
    let issued;
    try {
      issued = await signNodeCsr(deps.ca, csrPem, nodeId, siteCode, deps.env.NODE_CERT_VALIDITY_DAYS);
    } catch (err) {
      return reply.code(HTTP.status.badRequest).send({ error: err instanceof Error ? err.message : 'invalid CSR' });
    }
    await deps.prisma.discoveryNode.update({
      where: { id: nodeId },
      data: { status: 'enrolled', enrolledAt: new Date(), enrolTokenDigest: null, certificateSerial: issued.serialHex, certificateFingerprint: issued.fingerprintSha256, certificateExpiresAt: issued.notAfter },
    });
    return reply.code(HTTP.status.created).send({ certificatePem: issued.certificatePem, caPem: deps.caPem, expiresAt: issued.notAfter.toISOString() });
  });

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/heartbeat', async (req, reply) => {
    if (!(await requireNode(req, reply, req.params.nodeId))) return;
    const body = heartbeatSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    await deps.prisma.discoveryNode.update({
      where: { id: req.params.nodeId },
      data: { lastHeartbeatAt: new Date(), version: body.data.version, collectorIds: body.data.collectors },
    });
    return reply.code(HTTP.status.noContent).send();
  });

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/jobs/pull', async (req, reply) => {
    if (!(await requireNode(req, reply, req.params.nodeId))) return;
    const body = pullSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    const jobs = await deps.jobs.pull(req.params.nodeId, body.data.capacity, body.data.collectors);
    return { jobs };
  });

  app.post<{ Params: { jobId: string } }>('/v1/jobs/:jobId/result', async (req, reply) => {
    const parsed = collectorResultSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(HTTP.status.badRequest).send({ error: parsed.error.message });
    if (parsed.data.jobId !== req.params.jobId) return reply.code(HTTP.status.badRequest).send({ error: 'result jobId does not match the route' });
    if (!(await requireNode(req, reply, parsed.data.nodeId))) return;
    try {
      const { runId } = await deps.jobs.complete(parsed.data);
      await deps.results.publish(parsed.data);
      return reply.code(HTTP.status.accepted).send({ runId });
    } catch (err) {
      if (err instanceof JobNotFound) return reply.code(HTTP.status.notFound).send({ error: err.message });
      if (err instanceof JobNodeMismatch) return reply.code(HTTP.status.forbidden).send({ error: err.message });
      throw err;
    }
  });

  // REQ-DISC-004 — host agents enrol and report through their Node; the Node authenticates as itself and vouches for
  // the agent's client certificate, and the scheduler checks the agent belongs to that Node.
  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/agents/enrol', async (req, reply) => {
    if (!(await requireNode(req, reply, req.params.nodeId))) return;
    const body = agentEnrolSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    const node = await deps.prisma.discoveryNode.findUnique({ where: { id: req.params.nodeId }, include: { site: true } });
    if (!node) return reply.code(HTTP.status.forbidden).send({ error: 'node is not enrolled' });
    const agent = await deps.prisma.agent.findUnique({ where: { tenantId_agentId: { tenantId: node.tenantId, agentId: body.data.agentId } } });
    if (!agent || agent.nodeId !== node.id || agent.status !== 'pending' || !agent.enrolTokenDigest) return reply.code(HTTP.status.forbidden).send({ error: 'no pending enrolment for agent ' + body.data.agentId + ' on ' + node.id });
    const presented = Buffer.from(tokenDigest(body.data.token), 'hex');
    const expected = Buffer.from(agent.enrolTokenDigest, 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return reply.code(HTTP.status.forbidden).send({ error: 'enrolment token rejected' });
    let issued;
    try {
      issued = await signAgentCsr(deps.ca, body.data.csrPem, body.data.agentId, node.site.code, deps.env.NODE_CERT_VALIDITY_DAYS);
    } catch (err) {
      return reply.code(HTTP.status.badRequest).send({ error: err instanceof Error ? err.message : 'invalid CSR' });
    }
    await deps.prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'enrolled', enrolledAt: new Date(), enrolTokenDigest: null, certificateSerial: issued.serialHex, certificateFingerprint: issued.fingerprintSha256, certificateExpiresAt: issued.notAfter },
    });
    return reply.code(HTTP.status.created).send({ certificatePem: issued.certificatePem, caPem: deps.caPem, expiresAt: issued.notAfter.toISOString() });
  });

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/agents/report', async (req, reply) => {
    if (!(await requireNode(req, reply, req.params.nodeId))) return;
    const body = agentReportSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    const node = await deps.prisma.discoveryNode.findUnique({ where: { id: req.params.nodeId } });
    if (!node) return reply.code(HTTP.status.forbidden).send({ error: 'node is not enrolled' });
    const agent = await deps.prisma.agent.findUnique({ where: { tenantId_agentId: { tenantId: node.tenantId, agentId: body.data.agentId } } });
    if (!agent || agent.nodeId !== node.id || agent.status !== 'enrolled') return reply.code(HTTP.status.forbidden).send({ error: 'agent ' + body.data.agentId + ' is not enrolled on ' + node.id });
    if (agent.certificateFingerprint !== body.data.certificateFingerprint.toLowerCase()) return reply.code(HTTP.status.forbidden).send({ error: 'agent certificate does not match the enrolled one' });
    if (agent.certificateExpiresAt !== null && agent.certificateExpiresAt.getTime() < Date.now()) return reply.code(HTTP.status.forbidden).send({ error: 'agent certificate expired' });
    // One standing job per agent so every report is a run of the same job (history, evidence, metrics in one place).
    let jobId = agent.jobId;
    if (jobId === null) {
      const job = await deps.prisma.discoveryJob.create({
        data: {
          tenantId: node.tenantId, collectorId: AGENT_COLLECTOR_ID, nodeId: node.id, targets: [{ kind: 'host', value: body.data.agentId }], credentialRef: null, credentialType: 'none',
          timeoutMs: DISCOVERY.defaultJobTimeoutMs, rateLimitConcurrency: 1, rateLimitRps: 1, options: { agentId: body.data.agentId }, scheduledAt: new Date(), status: 'started', startedAt: new Date(), contractVersion: CONTRACT_VERSIONS.collector,
        },
      });
      jobId = job.id;
    }
    const parsedResult = collectorResultSchema.safeParse({
      jobId, runId: randomUUID(), tenantId: node.tenantId, collectorId: AGENT_COLLECTOR_ID, nodeId: node.id, status: 'success',
      startedAt: body.data.startedAt, finishedAt: body.data.finishedAt, cis: body.data.cis, relationships: body.data.relationships, evidence: body.data.evidence, errors: [],
      metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: body.data.cis.length, relationshipsEmitted: body.data.relationships.length, durationMs: Math.max(0, new Date(body.data.finishedAt).getTime() - new Date(body.data.startedAt).getTime()) },
      contractVersion: CONTRACT_VERSIONS.collector,
    });
    if (!parsedResult.success) return reply.code(HTTP.status.badRequest).send({ error: parsedResult.error.message });
    const result = parsedResult.data;
    const { runId } = await deps.jobs.complete(result);
    await deps.results.publish(result);
    await deps.prisma.agent.update({ where: { id: agent.id }, data: { jobId, lastReportAt: new Date(), version: body.data.agentVersion } });
    return reply.code(HTTP.status.accepted).send({ runId, jobId });
  });

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/credentials/resolve', async (req, reply) => {
    if (!(await requireNode(req, reply, req.params.nodeId))) return;
    const body = credentialSchema.safeParse(req.body);
    if (!body.success) return reply.code(HTTP.status.badRequest).send({ error: body.error.message });
    // A node may only resolve the credential of a job assigned to it and currently running.
    const job = await deps.prisma.discoveryJob.findUnique({ where: { id: body.data.jobId } });
    if (!job || job.nodeId !== req.params.nodeId || job.status !== 'started' || job.credentialRef !== body.data.credentialRef) {
      return reply.code(HTTP.status.forbidden).send({ error: 'credential is not assigned to this node for this job' });
    }
    const cred = await deps.secrets.read(body.data.credentialRef);
    return { type: cred.type, fields: cred.fields, expiresAt: cred.expiresAt };
  });

  return app;
}
