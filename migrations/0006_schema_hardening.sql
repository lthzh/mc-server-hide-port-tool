-- Migration: 0006_schema_hardening
-- Indexes, uniqueness constraints, cleanup redundant indexes

-- OAuth / GitHub lookups: providerId + accountId must be unique
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_uid"
  ON "account"("providerId", "accountId");

-- DNS host names are globally unique in this app
DROP INDEX IF EXISTS "dns_record_host_name_index";
CREATE UNIQUE INDEX IF NOT EXISTS "dns_record_host_name_unique"
  ON "dns_record"("host_name");

-- invite_code.code already has UNIQUE; drop redundant secondary index
DROP INDEX IF EXISTS "invite_code_code_index";

-- Prefer composite index matching listEnabledOAuthProviders query shape
DROP INDEX IF EXISTS "oauth_provider_enabled_index";
DROP INDEX IF EXISTS "oauth_provider_sort_order_index";
CREATE INDEX IF NOT EXISTS "oauth_provider_enabled_sort"
  ON "oauth_provider"("enabled", "sort_order", "created_at");

-- Help periodic / opportunistic expiry cleanup
CREATE INDEX IF NOT EXISTS "session_expiresAt_index" ON "session"("expiresAt");
CREATE INDEX IF NOT EXISTS "verification_expiresAt_index" ON "verification"("expiresAt");
CREATE INDEX IF NOT EXISTS "email_verification_expires_at_index"
  ON "email_verification"("expires_at");
