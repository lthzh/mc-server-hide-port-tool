-- Migration: 0005_oauth_unify_github
-- Unify GitHub into generic OAuth; add icon_url; migrate registration_mode github/both -> oauth/both

ALTER TABLE "oauth_provider" ADD COLUMN "icon_url" TEXT;

UPDATE "settings"
SET "registration_mode" = CASE
  WHEN "registration_mode" = 'github' THEN 'oauth'
  WHEN "registration_mode" = 'both' THEN 'both'
  ELSE "registration_mode"
END
WHERE "registration_mode" IN ('github', 'both');
