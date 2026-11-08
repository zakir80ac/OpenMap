-- REQ-AI-002 (ADR-052) — classification of unknown CIs: one suggestion per CI (class, layer, type, label title and
-- description, confidence and evidence), open until a person accepts it (which writes the CI's user label) or
-- dismisses it. acceptance rate = accepted / (accepted + dismissed).

-- CreateTable
CREATE TABLE "classification_suggestions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ciId" UUID NOT NULL,
    "deviceClass" TEXT NOT NULL,
    "layer" "CiLayer" NOT NULL,
    "type" "CiType",
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "state" "SuggestionState" NOT NULL DEFAULT 'open',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "classification_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classification_suggestions_tenantId_state_idx" ON "classification_suggestions"("tenantId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "classification_suggestions_tenantId_ciId_key" ON "classification_suggestions"("tenantId", "ciId");

-- AddForeignKey
ALTER TABLE "classification_suggestions" ADD CONSTRAINT "classification_suggestions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_suggestions" ADD CONSTRAINT "classification_suggestions_ciId_fkey" FOREIGN KEY ("ciId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
