-- REQ-UI-030 (ADR-020) — dashboards: per-tenant, owned by a user, optionally shared, seeded from a persona template
-- and customised; widgets is the JSON array of dashboardWidgetSchema.
CREATE TYPE "DashboardPersona" AS ENUM ('admin', 'cto_cio', 'ciso', 'finance', 'custom');
CREATE TABLE "dashboards" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "persona" "DashboardPersona" NOT NULL,
  "owner" TEXT NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "widgets" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dashboards_tenantId_owner_idx" ON "dashboards"("tenantId", "owner");
CREATE INDEX "dashboards_tenantId_shared_idx" ON "dashboards"("tenantId", "shared");
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
