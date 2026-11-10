// REQ-CORE-012 — Nest application factory on Fastify: CORS for the console origin, shutdown hooks,
// and the listen address. Shared by main.ts and anything that needs a configured app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv, type Env } from '@openmap/config';
import { IMPORTS } from '@openmap/constants';
import { AppModule } from './app.module.js';

/** Response headers the console reads across origins. */
export const EXPOSED_HEADERS = { contentDisposition: 'content-disposition' } as const;

/** Dual-stack wildcard: binds every IPv6 and IPv4 interface so the container port maps work. */
export const LISTEN_HOST = '::';

/** Origins the console is served at: its public URL and, when configured, the alias it is also opened at. */
export function consoleOrigins(env: Pick<Env, 'PUBLIC_CONSOLE_URL' | 'PUBLIC_CONSOLE_ALIAS_URL'>): string[] {
  const origins = [env.PUBLIC_CONSOLE_URL, env.PUBLIC_CONSOLE_ALIAS_URL]
    .filter((u): u is string => u !== undefined)
    .map((u) => new URL(u).origin);
  return [...new Set(origins)];
}

export async function createApp(env: Env = loadEnv()): Promise<NestFastifyApplication> {
  // REQ-CMDB-033: an import file travels as base64 in a GraphQL body, so the body limit is the import limit.
  // REQ-INT-012 (ADR-073): the raw body is kept so a monitoring sender's HMAC signature is checked over its bytes.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: IMPORTS.maxBodyBytes }), { logger: ['error', 'warn', 'log'], rawBody: true });
  // REQ-CMDB-033: the export's file name travels in content-disposition, which a cross-origin fetch only sees when exposed.
  app.enableCors({ origin: consoleOrigins(env), credentials: true, exposedHeaders: [EXPOSED_HEADERS.contentDisposition] });
  app.enableShutdownHooks();
  return app;
}

export async function bootstrap(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.API_PORT, LISTEN_HOST);
  return app;
}
