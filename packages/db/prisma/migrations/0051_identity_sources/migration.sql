-- REQ-INT-016 (ADR-074) — identity sources: the directories (Active Directory, other LDAP) and OpenID Connect providers
-- (Entra ID, Okta, other) a tenant's people sign in through, applied to Keycloak by the API. Secrets stay in OpenBao.

-- CreateTable
CREATE TABLE "identity_sources" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL,
    "secretRef" TEXT NOT NULL,
    "roleMappings" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "keycloakId" TEXT,
    "lastError" TEXT,
    "lastTestAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastSync" JSONB,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identity_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_sources_alias_key" ON "identity_sources"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "identity_sources_tenantId_name_key" ON "identity_sources"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "identity_sources" ADD CONSTRAINT "identity_sources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
