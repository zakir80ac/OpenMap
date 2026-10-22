// REQ-UI-003 — Next.js configuration: workspace packages transpiled, standalone output for the compose image, and the
// public API origin exposed to the browser from validated config (never a literal URL in source).
// This is .mjs rather than .ts because Next transpiles next.config.ts to CommonJS and `require`s its imports, while
// @openmap/config is published with an ESM-only `import` export condition; .mjs is loaded with native import().
import { join } from 'node:path';
import { loadEnv } from '@openmap/config';

const env = loadEnv();

/**
 * The deploy images (compose, helm) are built on Linux and ship the standalone bundle. Next's standalone tracer
 * recreates pnpm's node_modules symlinks, which Windows refuses without the symlink privilege (EPERM), so a Windows
 * development build keeps the default output; nothing else differs between the two.
 */
const standalone = process.platform !== 'win32';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: 'standalone' } : {}),
  reactStrictMode: true,
  // The console lives in a pnpm workspace; tracing from the repository root keeps hoisted dependencies in the bundle.
  outputFileTracingRoot: join(process.cwd(), '..', '..'),
  transpilePackages: ['@openmap/ui', '@openmap/i18n', '@openmap/config', '@openmap/constants', '@openmap/contracts'],
  env: {
    NEXT_PUBLIC_API_URL: env.PUBLIC_API_URL,
    NEXT_PUBLIC_DEFAULT_LOCALE: env.DEFAULT_LOCALE,
    // REQ-SEC-001 — the browser-side OIDC client: Keycloak as the browser reaches it, the realm and the public client.
    NEXT_PUBLIC_KEYCLOAK_URL: env.PUBLIC_KEYCLOAK_URL,
    NEXT_PUBLIC_KEYCLOAK_REALM: env.KEYCLOAK_REALM,
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: env.KEYCLOAK_CLIENT_ID,
  },
};

export default nextConfig;
