-- REQ-AI-008 (ADR-028) — persisted assistant conversations: one row per conversation owned by the user who asked,
-- one row per turn holding the question and the answer as returned (assistantTurnAnswerSchema), so a thread survives
-- a reload and a follow-up is read against the previous turn. Indexes are tenant-scoped; turns go with their
-- conversation, conversations with their tenant.
CREATE TYPE "AssistantTurnOutcome" AS ENUM ('answered', 'clarified', 'failed');

CREATE TABLE "assistant_conversations" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_conversations_tenantId_userId_updatedAt_idx" ON "assistant_conversations"("tenantId", "userId", "updatedAt" DESC);
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assistant_turns" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome" "AssistantTurnOutcome" NOT NULL,
  "locale" "Locale" NOT NULL,
  "question" TEXT NOT NULL,
  "answer" JSONB NOT NULL,
  CONSTRAINT "assistant_turns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_turns_tenantId_conversationId_at_idx" ON "assistant_turns"("tenantId", "conversationId", "at");
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
