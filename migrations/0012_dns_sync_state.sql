-- Migration: 0012_dns_sync_state
-- deployment: backward-compatible
-- Persist in-flight Cloudflare DNS mutations so interrupted requests can be retried safely.

ALTER TABLE "dns_record" ADD COLUMN "sync_status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "dns_record" ADD COLUMN "sync_error_code" TEXT;
ALTER TABLE "dns_record" ADD COLUMN "sync_updated_at" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "dns_record" ADD COLUMN "pending_server_address" TEXT;
ALTER TABLE "dns_record" ADD COLUMN "pending_port" INTEGER;
ALTER TABLE "dns_record" ADD COLUMN "pending_target_type" TEXT;

UPDATE "dns_record"
SET "sync_status" = 'active',
    "sync_updated_at" = CASE WHEN "created_at" > 0 THEN "created_at" ELSE 0 END
WHERE "sync_updated_at" = 0;

CREATE INDEX IF NOT EXISTS "dns_record_sync_status_updated_index"
  ON "dns_record"("sync_status", "sync_updated_at");

CREATE TRIGGER IF NOT EXISTS "dns_record_sync_status_valid_insert"
BEFORE INSERT ON "dns_record" WHEN NEW."sync_status" NOT IN ('creating', 'active', 'updating', 'error')
BEGIN
  SELECT RAISE(ABORT, 'invalid dns sync status');
END;

CREATE TRIGGER IF NOT EXISTS "dns_record_sync_status_valid_update"
BEFORE UPDATE OF "sync_status" ON "dns_record" WHEN NEW."sync_status" NOT IN ('creating', 'active', 'updating', 'error')
BEGIN
  SELECT RAISE(ABORT, 'invalid dns sync status');
END;
-- Verification throttles are ephemeral; remove legacy rows whose keys contained raw email/IP values.
DELETE FROM "rate_limit_bucket" WHERE "key" LIKE 'email_verify_fail:%';
