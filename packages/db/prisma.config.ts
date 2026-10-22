// REQ-CORE-009 — Prisma CLI configuration. The datasource URL itself is read by the schema
// through env("POSTGRES_URL"); src/migrate-postgres.ts supplies it from loadEnv() so the
// documented default from @openmap/config applies when the variable is unset.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
});
