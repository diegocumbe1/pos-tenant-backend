-- Only telemetry metadata. No user IDs, utterances, entity names or tokens.
CREATE TYPE "AssistantChannel" AS ENUM ('WEB', 'ALEXA');
CREATE TYPE "AssistantConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "AssistantOutcome" AS ENUM ('ANSWERED', 'NO_DATA', 'CLARIFIED', 'FALLBACK', 'DENIED_PERMISSION', 'DENIED_PLAN', 'ERROR');
CREATE TABLE "assistant_query_log" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tenantId" TEXT NOT NULL, "branchId" TEXT, "role" TEXT NOT NULL,
 "channel" "AssistantChannel" NOT NULL, "vertical" TEXT NOT NULL,
 "intentId" TEXT NOT NULL, "outcome" "AssistantOutcome" NOT NULL,
 "confidence" "AssistantConfidence" NOT NULL, "level" TEXT NOT NULL,
 "scope" TEXT, "resolvedTo" TEXT, "latencyMs" INTEGER,
 "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "assistant_query_log_tenantId_at_idx" ON "assistant_query_log"("tenantId", "at");
CREATE INDEX "assistant_query_log_tenantId_intentId_at_idx" ON "assistant_query_log"("tenantId", "intentId", "at");
CREATE INDEX "assistant_query_log_intentId_outcome_idx" ON "assistant_query_log"("intentId", "outcome");
-- Enforce append-only even for accidental ORM updates/deletes.
CREATE FUNCTION assistant_query_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'assistant_query_log is append-only'; END;
$$;
CREATE TRIGGER assistant_query_log_append_only BEFORE UPDATE OR DELETE ON assistant_query_log
FOR EACH ROW EXECUTE FUNCTION assistant_query_log_append_only();
