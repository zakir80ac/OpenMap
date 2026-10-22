// REQ-DISC-028 REQ-DISC-031 REQ-SEC-004 — the HTTP surface Discovery Nodes talk to, over mTLS:
// enrolment (one-time token → signed certificate), heartbeat, job pull, result post, credential
// resolution. Every mTLS route checks the peer certificate names the node in the path.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HTTP } from '@openmap/constants';
import { collectorResultSchema } from '@openmap/contracts';
import type { Env } from '@openmap/config';
import type { PrismaClient } from '@openmap/db';
import { JobNodeMismatch, JobNotFound, type JobStore } from './jobs.js';
import { signNodeCsr, type Ca } from './pki.js';
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
