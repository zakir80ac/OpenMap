-- REQ-AI-003 (ADR-053) — anomaly findings: one row per rule and subject (an address claimed twice, an unmanaged device
-- in a data centre, a flapping service), open while the rule holds, cleared when it stops, with the facts the rule
-- found and the model's explanation once asked.

-- CreateTable
CREATE TABLE "anomaly_findings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "subjectCiId" UUID NOT NULL,
    "facts" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "clearedAt" TIMESTAMPTZ(3),
    "explanation" TEXT,
    "explanationLocale" TEXT,
    "explainedAt" TIMESTAMPTZ(3),

    CONSTRAINT "anomaly_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "anomaly_findings_tenantId_state_idx" ON "anomaly_findings"("tenantId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_findings_tenantId_rule_subjectCiId_key" ON "anomaly_findings"("tenantId", "rule", "subjectCiId");

-- AddForeignKey
ALTER TABLE "anomaly_findings" ADD CONSTRAINT "anomaly_findings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
