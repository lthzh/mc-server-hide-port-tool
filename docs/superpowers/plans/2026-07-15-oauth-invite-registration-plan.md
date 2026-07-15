# Secure OAuth Invite Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate OAuth invite-code bypasses by requiring a one-time, provider/state-bound registration intent before Better Auth may create a new OAuth user or issue a session.

**Architecture:** The app-owned registration endpoint creates a short-lived intent, stores only SHA-256 hashes, and reserves an invite with a conditional D1 update. Better Auth `user.create.before` authorizes that intent on the generic OAuth callback, while `user.create.after` marks it consumed and lets a SQLite trigger atomically assign the invite. The public Better Auth OAuth sign-in endpoint is blocked; existing-user login and account linking remain server-side API calls and do not require registration intents.

**Tech Stack:** TypeScript, Hono, Better Auth 1.6.23, Cloudflare Workers/D1, SQLite triggers, Vitest 4.1.10, Miniflare 4.20260706.0, pnpm.

---

## File map

- Create `migrations/0010_oauth_registration_intents.sql`: schema, indexes, reservation columns, consume/release triggers.
- Create `src/services/oauth-registration-intents.ts`: token/hash/cookie helpers, lifecycle, reservation, cleanup, reconciliation.
- Create `src/lib/better-auth-oauth-context.ts`: structural parser for Better Auth generic callback hook context.
- Modify `src/services/invite-codes.ts`: make existing email/admin invite flows reservation-aware.
- Modify `src/auth.ts`: compose numeric ID allocation with OAuth intent authorization/finalization hooks.
- Modify `src/routes/auth.ts`: create/bind intents, simplify completion, add fixed error callback, block public OAuth entry.
- Modify `package.json`, `pnpm-lock.yaml`; create `vitest.config.ts`.
- Create `tests/helpers/d1.ts`, `tests/helpers/auth.ts`, `tests/oauth-registration-intents.test.ts`, `tests/better-auth-oauth-context.test.ts`, `tests/oauth-registration-routes.test.ts`, and `tests/better-auth-oauth-hooks.test.ts`.

## Stable names

```ts
OAUTH_REGISTRATION_INTENT_COOKIE = 'oauth_registration_intent'
OAUTH_REGISTRATION_INTENT_TTL_MS = 10 * 60 * 1000
OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS = 60 * 60 * 1000
OAUTH_REGISTRATION_CONSUMED_RETENTION_MS = 24 * 60 * 60 * 1000
```

Lifecycle:

```text
pending:    authorized_at IS NULL AND consumed_at IS NULL
authorized: authorized_at IS NOT NULL AND consumed_at IS NULL
consumed:   consumed_at IS NOT NULL
```

Routes map every provider/intent/database failure to browser-visible code `OAUTH_REGISTRATION_FAILED` and message `OAuth 注册失败，请重新发起注册`. Internal errors may use stable domain codes but must never contain clear tokens, invite codes, authorization codes, or provider token material.

---

### Task 1: Pin Better Auth and establish the test runner

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `vitest.config.ts`

- [ ] **Step 1: Verify the current failure**

Run `pnpm test`.

Expected: pnpm reports that the `test` script is missing.

- [ ] **Step 2: Update package metadata**

Preserve unrelated entries and set:

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy --minify",
    "cf-typegen": "wrangler types --env-interface CloudflareBindings",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@better-auth/passkey": "1.6.23",
    "better-auth": "1.6.23",
    "hono": "^4.12.27"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "miniflare": "4.20260706.0",
    "typescript": "^7.0.2",
    "vitest": "4.1.10",
    "wrangler": "^4.108.0"
  }
}
```

The exact Better Auth version is a security contract because Task 6 tests its 1.6.23 hook ordering on D1.

- [ ] **Step 3: Add Vitest configuration**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    isolate: true,
    restoreMocks: true,
    clearMocks: true
  }
})
```

- [ ] **Step 4: Install and verify startup**

Run:

```powershell
pnpm install --frozen-lockfile=false
pnpm test -- --passWithNoTests
```

Expected: install succeeds and Vitest exits successfully with no test files.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "test: add OAuth security test runner"
```

---

### Task 2: Add the D1 intent schema and atomic triggers

**Files:**
- Create: `migrations/0010_oauth_registration_intents.sql`
- Create: `tests/helpers/d1.ts`
- Create: `tests/oauth-registration-intents.test.ts`

- [ ] **Step 1: Create a real-D1 helper**

Create `tests/helpers/d1.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Miniflare } from 'miniflare'

export type TestD1 = { db: D1Database; dispose: () => Promise<void> }

export async function createTestD1(): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-08',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: crypto.randomUUID() }
  })
  const db = await mf.getD1Database('DB')
  const dir = resolve(process.cwd(), 'migrations')
  const files = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  for (const file of files) await db.exec(await readFile(resolve(dir, file), 'utf8'))
  return { db, dispose: async () => mf.dispose() }
}

export async function seedUser(
  db: D1Database,
  input: { id?: string; email?: string; name?: string } = {}
): Promise<string> {
  const id = input.id ?? '9001'
  const now = Date.now()
  await db.prepare(
    `INSERT INTO user
     (id, name, email, emailVerified, createdAt, updatedAt, role, super_admin)
     VALUES (?, ?, ?, 1, ?, ?, 'admin', 1)`
  ).bind(id, input.name ?? 'Fixture Admin', input.email ?? 'fixture-admin@example.test', now, now).run()
  return id
}

export async function seedInvite(
  db: D1Database,
  createdBy: string,
  input: { id?: string; code?: string; revoked?: number; usedBy?: string | null } = {}
): Promise<{ id: string; code: string }> {
  const id = input.id ?? crypto.randomUUID()
  const code = input.code ?? 'INVITE-ONE'
  await db.prepare(
    `INSERT INTO invite_code
     (id, code, created_by, created_at, used_by, used_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, code, createdBy, Date.now(), input.usedBy ?? null,
    input.usedBy ? Date.now() : null, input.revoked ?? 0).run()
  return { id, code }
}
```

- [ ] **Step 2: Write failing migration tests**

Create `tests/oauth-registration-intents.test.ts`; use `afterEach` to dispose every Miniflare instance. Add tests that:

- inspect `PRAGMA table_info('oauth_registration_intent')` for all ten fields;
- inspect `PRAGMA table_info('invite_code')` for `reserved_intent_id` and `reserved_at`;
- insert an authorized intent and reservation, set `consumed_at`, and assert invite `used_by/used_at` are assigned while reservation fields become null;
- set `consumed_at` without the matching reservation and assert rejection contains `oauth_invite_reservation_invalid`;
- set `consumed_at` without authorization and assert rejection contains `oauth_intent_not_authorized`;
- delete a pending intent and assert its matching reservation is released;
- delete an authorized intent and assert its reservation is not released.

Use actual D1 statements rather than mocks for every trigger assertion.

- [ ] **Step 3: Run and confirm failure**

Run `pnpm test -- tests/oauth-registration-intents.test.ts`.

Expected: missing table/column failures.

- [ ] **Step 4: Create the migration**

Create `migrations/0010_oauth_registration_intents.sql`:

```sql
-- Migration: 0010_oauth_registration_intents
ALTER TABLE "invite_code" ADD COLUMN "reserved_intent_id" TEXT;
ALTER TABLE "invite_code" ADD COLUMN "reserved_at" INTEGER;
CREATE INDEX IF NOT EXISTS "invite_code_reserved_intent_id_index"
  ON "invite_code"("reserved_intent_id");
CREATE INDEX IF NOT EXISTS "invite_code_reserved_at_index"
  ON "invite_code"("reserved_at");

CREATE TABLE IF NOT EXISTS "oauth_registration_intent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "provider_id" TEXT NOT NULL,
  "oauth_state_hash" TEXT,
  "invite_code_id" TEXT,
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "authorized_at" INTEGER,
  "authorized_user_id" TEXT,
  "consumed_at" INTEGER,
  FOREIGN KEY ("invite_code_id") REFERENCES "invite_code"("id")
    ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS "oauth_registration_intent_expires_at_index"
  ON "oauth_registration_intent"("expires_at");
CREATE INDEX IF NOT EXISTS "oauth_registration_intent_oauth_state_hash_index"
  ON "oauth_registration_intent"("oauth_state_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_registration_intent_authorized_user_id_unique"
  ON "oauth_registration_intent"("authorized_user_id")
  WHERE "authorized_user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "oauth_registration_intent_consumed_at_index"
  ON "oauth_registration_intent"("consumed_at");

CREATE TRIGGER IF NOT EXISTS "oauth_registration_intent_consume_invite"
BEFORE UPDATE OF "consumed_at" ON "oauth_registration_intent"
WHEN OLD."consumed_at" IS NULL AND NEW."consumed_at" IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW."authorized_at" IS NULL OR NEW."authorized_user_id" IS NULL
      THEN RAISE(ABORT, 'oauth_intent_not_authorized')
    WHEN NEW."invite_code_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "invite_code"
      WHERE "id" = NEW."invite_code_id"
        AND "used_by" IS NULL
        AND "revoked" = 0
        AND "reserved_intent_id" = NEW."id"
    ) THEN RAISE(ABORT, 'oauth_invite_reservation_invalid')
  END;
  UPDATE "invite_code"
  SET "used_by" = NEW."authorized_user_id",
      "used_at" = NEW."consumed_at",
      "reserved_intent_id" = NULL,
      "reserved_at" = NULL
  WHERE "id" = NEW."invite_code_id"
    AND "used_by" IS NULL
    AND "revoked" = 0
    AND "reserved_intent_id" = NEW."id";
END;

CREATE TRIGGER IF NOT EXISTS "oauth_registration_intent_release_pending_invite"
AFTER DELETE ON "oauth_registration_intent"
WHEN OLD."authorized_at" IS NULL AND OLD."invite_code_id" IS NOT NULL
BEGIN
  UPDATE "invite_code"
  SET "reserved_intent_id" = NULL, "reserved_at" = NULL
  WHERE "id" = OLD."invite_code_id"
    AND "used_by" IS NULL
    AND "reserved_intent_id" = OLD."id";
END;
```

- [ ] **Step 5: Run and commit**

```powershell
pnpm test -- tests/oauth-registration-intents.test.ts
git add migrations/0010_oauth_registration_intents.sql tests/helpers/d1.ts tests/oauth-registration-intents.test.ts
git commit -m "feat: add OAuth registration intent schema"
```

Expected: migration and trigger tests pass before commit.

---

### Task 3: Make existing invite operations reservation-aware

**Files:**
- Modify: `src/services/invite-codes.ts`
- Modify: `tests/oauth-registration-intents.test.ts`

- [ ] **Step 1: Add failing compatibility tests**

For an unused invite with `reserved_intent_id = 'intent-active'`, assert:

```ts
await expect(assertInviteCodeAvailable(db, code)).resolves.toEqual({
  ok: false,
  message: '邀请码正在使用中'
})
await expect(consumeInviteCode(db, code, '9002')).resolves.toEqual({
  ok: false,
  message: '邀请码正在使用中'
})
await expect(revokeInviteCode(db, inviteId)).resolves.toEqual({
  ok: false,
  message: '邀请码正在使用中，暂时无法作废'
})
```

Also assert create/list/find return `reserved_intent_id` and `reserved_at`, both null for a fresh invite.

- [ ] **Step 2: Run the focused test**

Run `pnpm test -- tests/oauth-registration-intents.test.ts -t "reserved invite"`.

Expected: current service treats the reserved invite as available.

- [ ] **Step 3: Update type, selects, and conditions**

Add to `InviteCodeRow` and all invite selects/returned objects:

```ts
reserved_intent_id: string | null
reserved_at: number | null
```

In `assertInviteCodeAvailable`, after used/revoked checks:

```ts
if (invite.reserved_intent_id) return { ok: false, message: '邀请码正在使用中' }
```

Change email-flow consumption to:

```sql
UPDATE invite_code
SET used_by = ?, used_at = ?
WHERE id = ?
  AND used_by IS NULL
  AND revoked = 0
  AND reserved_intent_id IS NULL
```

Select `reserved_intent_id` in `revokeInviteCode`, reject it with `邀请码正在使用中，暂时无法作废`, and include `AND reserved_intent_id IS NULL` in the revoke update. Check `meta.changes`; a lost race returns the same reservation message.

- [ ] **Step 4: Run and commit**

```powershell
pnpm test -- tests/oauth-registration-intents.test.ts
git add src/services/invite-codes.ts tests/oauth-registration-intents.test.ts
git commit -m "fix: respect OAuth invite reservations"
```

Expected: all invite and trigger tests pass, including ordinary email invite consumption.

---

### Task 4: Implement the intent lifecycle service with real-D1 tests

**Files:**
- Create: `src/services/oauth-registration-intents.ts`
- Modify: `tests/oauth-registration-intents.test.ts`

- [ ] **Step 1: Add failing lifecycle tests against these exports**

```ts
import {
  OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS,
  OAUTH_REGISTRATION_CONSUMED_RETENTION_MS,
  OAUTH_REGISTRATION_INTENT_COOKIE,
  OAuthRegistrationIntentError,
  authorizeOAuthRegistrationIntent,
  bindOAuthRegistrationIntentState,
  buildOAuthRegistrationIntentCookie,
  buildOAuthRegistrationIntentClearCookie,
  cleanupOAuthRegistrationIntents,
  consumeAuthorizedOAuthRegistrationIntent,
  createOAuthRegistrationIntent,
  createOAuthRegistrationSecurityEvent,
  releasePendingOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'
```

Use fixed `now` values and cover:

1. generated token is 43-character base64url (32 random bytes); DB stores only a 64-character SHA-256 hash;
2. cookie has `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=600`, and conditional `Secure`;
3. two concurrent creates for one invite yield exactly one fulfilled result and one `INVITE_UNAVAILABLE` rejection;
4. state binding succeeds once and rejects rebinding;
5. authorization rejects missing/wrong token, state, provider, expiry, replay, disabled registration, `email` mode, and lost reservation;
6. invite-free authorization succeeds when latest settings do not require an invite and fails when latest settings now require one;
7. consumption is idempotent and atomically assigns the invite;
8. pending release clears the reservation, while authorized release is a no-op;
9. cleanup completes an authorized intent when its user exists;
10. cleanup preserves an authorized intent without a user during the one-hour quarantine;
11. cleanup releases an authorized reservation only after quarantine and a repeated user-absence predicate;
12. cleanup deletes retained consumed intents without changing used invite ownership;
13. errors and serialized rows never contain the clear token or clear invite code.

Use `Promise.allSettled` for concurrency and assert one `fulfilled`, one `rejected`.

- [ ] **Step 2: Run and confirm missing-module failure**

Run `pnpm test -- tests/oauth-registration-intents.test.ts`.

Expected: import failure for `src/services/oauth-registration-intents.ts`.

- [ ] **Step 3: Create constants, errors, hashing, and cookies**

Start `src/services/oauth-registration-intents.ts` with:

```ts
export const OAUTH_REGISTRATION_INTENT_COOKIE = 'oauth_registration_intent'
export const OAUTH_REGISTRATION_INTENT_TTL_MS = 10 * 60 * 1000
export const OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS = 60 * 60 * 1000
export const OAUTH_REGISTRATION_CONSUMED_RETENTION_MS = 24 * 60 * 60 * 1000

export type OAuthRegistrationIntentErrorCode =
  | 'INTENT_REQUIRED'
  | 'INTENT_INVALID'
  | 'INTENT_EXPIRED'
  | 'INTENT_REPLAYED'
  | 'STATE_INVALID'
  | 'PROVIDER_INVALID'
  | 'REGISTRATION_DISABLED'
  | 'INVITE_REQUIRED'
  | 'INVITE_INVALID'
  | 'INVITE_UNAVAILABLE'
  | 'INTENT_FINALIZATION_FAILED'

export class OAuthRegistrationIntentError extends Error {
  constructor(readonly code: OAuthRegistrationIntentErrorCode) {
    super(code)
    this.name = 'OAuthRegistrationIntentError'
  }
}

export type OAuthRegistrationIntentRow = {
  id: string
  token_hash: string
  provider_id: string
  oauth_state_hash: string | null
  invite_code_id: string | null
  created_at: number
  expires_at: number
  authorized_at: number | null
  authorized_user_id: string | null
  consumed_at: number | null
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function buildOAuthRegistrationIntentCookie(token: string, secure: boolean): string {
  return [
    `${OAUTH_REGISTRATION_INTENT_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

export function buildOAuthRegistrationIntentClearCookie(secure: boolean): string {
  return [
    `${OAUTH_REGISTRATION_INTENT_COOKIE}=`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}
```

- [ ] **Step 4: Implement pending creation and reservation**

Use this exact signature:

```ts
export async function createOAuthRegistrationIntent(
  db: D1Database,
  input: { providerId: string; inviteRequired: boolean; inviteCode: string; now?: number }
): Promise<{ id: string; token: string; expiresAt: number }>
```

Concrete behavior:

- `providerId.trim()` must be non-empty or throw `PROVIDER_INVALID`;
- normalize invite with `trim().toUpperCase()`;
- when required, select only a matching invite with `used_by IS NULL`, `revoked = 0`, and `reserved_intent_id IS NULL`; missing code throws `INVITE_REQUIRED`, invalid/unavailable code uses `INVITE_INVALID` or `INVITE_UNAVAILABLE` without echoing the code;
- insert intent with a random UUID, token hash, provider, optional invite ID, `created_at = now`, `expires_at = now + OAUTH_REGISTRATION_INTENT_TTL_MS`, and null state/authorization/consumption;
- reserve with this conditional statement:

```sql
UPDATE invite_code
SET reserved_intent_id = ?, reserved_at = ?
WHERE id = ?
  AND used_by IS NULL
  AND revoked = 0
  AND reserved_intent_id IS NULL
```

- when reservation changes zero rows, delete the still-pending intent and throw `INVITE_UNAVAILABLE`.

- [ ] **Step 5: Implement one-time state binding**

```ts
export async function bindOAuthRegistrationIntentState(
  db: D1Database,
  input: { id: string; token: string; providerId: string; state: string; now?: number }
): Promise<void>
```

Reject empty state. Hash token/state and require matching `id`, hashes, provider, `oauth_state_hash IS NULL`, pending state, and `expires_at > now`; set `oauth_state_hash` and require exactly one change. Any mismatch throws `INTENT_INVALID`.

- [ ] **Step 6: Implement current-policy authorization**

```ts
export async function authorizeOAuthRegistrationIntent(
  db: D1Database,
  input: { token: string; providerId: string; state: string; userId: string; now?: number }
): Promise<{ intentId: string }>
```

Read policy directly from D1, bypassing the five-second cache:

```sql
SELECT registration_enabled, registration_mode, invite_required
FROM settings WHERE id = 'default'
```

Require enabled mode `oauth` or `both`; if current `invite_required = 1`, require a non-null `invite_code_id`. Authorize with one conditional update containing token/state/provider hashes, pending state, expiry, and:

```sql
AND (
  invite_code_id IS NULL OR EXISTS (
    SELECT 1 FROM invite_code
    WHERE invite_code.id = oauth_registration_intent.invite_code_id
      AND invite_code.used_by IS NULL
      AND invite_code.revoked = 0
      AND invite_code.reserved_intent_id = oauth_registration_intent.id
  )
)
```

Set `authorized_at` and `authorized_user_id`; require one change. A hash-only diagnostic lookup may classify `INTENT_EXPIRED`, `INTENT_REPLAYED`, `PROVIDER_INVALID`, `STATE_INVALID`, or `INVITE_UNAVAILABLE` for tests/logs, but error messages contain only the domain code.

- [ ] **Step 7: Implement finalization and pending release**

```ts
export async function consumeAuthorizedOAuthRegistrationIntent(
  db: D1Database,
  input: {
    userId: string
    token: string
    providerId: string
    state: string
    now?: number
  }
): Promise<void>

export async function releasePendingOAuthRegistrationIntent(
  db: D1Database,
  token: string | null | undefined
): Promise<boolean>
```

Finalization hashes the supplied token and state, then accepts an already-consumed row or conditionally sets `consumed_at` only when the same row matches all of `authorized_user_id`, `token_hash`, `oauth_state_hash`, `provider_id`, authorized state, and unconsumed state. The trigger assigns the invite atomically. Cleanup/reconciliation must call a private finalize-by-intent-ID helper after independently establishing that the authorized user exists; it must not weaken the public callback-bound function. Convert SQL/trigger failures to `INTENT_FINALIZATION_FAILED` without carrying the SQL message.

Pending release hashes token and executes:

```sql
DELETE FROM oauth_registration_intent
WHERE token_hash = ?
  AND authorized_at IS NULL
  AND consumed_at IS NULL
```

Return true only for one deleted row; never delete authorized rows.

- [ ] **Step 8: Implement cleanup/reconciliation**

```ts
export async function cleanupOAuthRegistrationIntents(
  db: D1Database,
  now = Date.now()
): Promise<{
  releasedPending: number
  reconciled: number
  releasedAuthorized: number
  deletedConsumed: number
}>
```

Run four bounded passes (50 candidates each):

1. delete expired pending rows; pending-delete trigger releases reservations;
2. finalize authorized/unconsumed rows whose `authorized_user_id` exists in `user`;
3. for rows past the one-hour quarantine whose user remains absent, use `db.batch` to conditionally clear only the invite reservation still owned by that intent, then delete only that same authorized intent; repeat quarantine and `NOT EXISTS (SELECT 1 FROM user ...)` predicates in both mutations;
4. delete consumed rows older than `OAUTH_REGISTRATION_CONSUMED_RETENTION_MS`; this must not modify used invites.

No mutation may rely only on a preceding select. Count only verified changes. The function is idempotent.

- [ ] **Step 9: Add privacy-safe security event serialization**

Export:

```ts
export type OAuthRegistrationSecurityEvent = {
  event: 'oauth_registration_failed'
  intent_id: string | null
  provider_id: string
  failure_type: OAuthRegistrationIntentErrorCode | 'UNEXPECTED_FAILURE'
  at: number
  correlation_id?: string
}

export function createOAuthRegistrationSecurityEvent(
  error: unknown,
  input: { providerId: string; at?: number; correlationId?: string }
): OAuthRegistrationSecurityEvent
```

Extend `OAuthRegistrationIntentError` with optional safe metadata `intentId?: string`; never attach token, state, invite, authorization code, provider token, or email. The serializer returns exactly the fields above, uses `UNEXPECTED_FAILURE` for unknown errors, trims provider ID, and includes correlation ID only when provided. Add a test that serializes errors constructed near clear token/invite fixtures and asserts JSON output contains neither fixture nor any email/token field name.

Task 6 and Task 7 must log only `JSON.stringify(createOAuthRegistrationSecurityEvent(...))` in authorization/finalization/start-route catch blocks, then rethrow or return the stable response. They must not log the original error object.

- [ ] **Step 10: Run and commit**

```powershell
pnpm test -- tests/oauth-registration-intents.test.ts
git add src/services/oauth-registration-intents.ts tests/oauth-registration-intents.test.ts
git commit -m "feat: implement OAuth registration intents"
```

Expected: all schema, concurrency, lifecycle, quarantine, trigger, and privacy tests pass.

---

### Task 5: Parse Better Auth generic callback context

**Files:**
- Create: `src/lib/better-auth-oauth-context.ts`
- Create: `tests/better-auth-oauth-context.test.ts`

- [ ] **Step 1: Write the tests**

Create `tests/better-auth-oauth-context.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readGenericOAuthCallback } from '../src/lib/better-auth-oauth-context'

function context(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    path: '/oauth2/callback/:providerId',
    params: { providerId: 'fixture' },
    query: { state: 'oauth-state' },
    getCookie: (name: string) => name === 'oauth_registration_intent' ? 'intent-token' : null,
    ...overrides
  }
}

describe('readGenericOAuthCallback', () => {
  it('extracts the verified Better Auth 1.6.23 callback fields', () => {
    expect(readGenericOAuthCallback(context())).toEqual({
      providerId: 'fixture', state: 'oauth-state', intentToken: 'intent-token'
    })
  })

  it.each([
    { method: 'POST' },
    { path: '/sign-up/email' },
    { path: '/oauth2/link' },
    { params: { providerId: '' } }
  ])('ignores non-generic-callback context: %o', (overrides) => {
    expect(readGenericOAuthCallback(context(overrides))).toBeNull()
  })

  it('returns empty credentials on a recognized callback so authorization fails closed', () => {
    expect(readGenericOAuthCallback(context({ query: {}, getCookie: () => null }))).toEqual({
      providerId: 'fixture', state: '', intentToken: ''
    })
  })
})
```

- [ ] **Step 2: Run and confirm missing module**

Run `pnpm test -- tests/better-auth-oauth-context.test.ts`.

Expected: module-not-found failure.

- [ ] **Step 3: Implement the parser**

Create `src/lib/better-auth-oauth-context.ts`:

```ts
import { OAUTH_REGISTRATION_INTENT_COOKIE } from '../services/oauth-registration-intents'

type HookContextLike = {
  method?: unknown
  path?: unknown
  params?: unknown
  query?: unknown
  getCookie?: unknown
}

export type GenericOAuthCallback = {
  providerId: string
  state: string
  intentToken: string
}

export function readGenericOAuthCallback(value: unknown): GenericOAuthCallback | null {
  if (!value || typeof value !== 'object') return null
  const context = value as HookContextLike
  if (context.method !== 'GET' || context.path !== '/oauth2/callback/:providerId') return null
  const params = context.params && typeof context.params === 'object'
    ? context.params as Record<string, unknown> : {}
  const providerId = String(params.providerId ?? '').trim()
  if (!providerId) return null
  const query = context.query && typeof context.query === 'object'
    ? context.query as Record<string, unknown> : {}
  const getCookie = typeof context.getCookie === 'function'
    ? context.getCookie as (name: string) => string | null : () => null
  return {
    providerId,
    state: String(query.state ?? ''),
    intentToken: String(getCookie(OAUTH_REGISTRATION_INTENT_COOKIE) ?? '')
  }
}
```

This deliberately uses structural typing instead of importing a transitive Better Auth type.

- [ ] **Step 4: Run and commit**

```powershell
pnpm test -- tests/better-auth-oauth-context.test.ts
git add src/lib/better-auth-oauth-context.ts tests/better-auth-oauth-context.test.ts
git commit -m "feat: identify generic OAuth callbacks"
```

---

### Task 6: Enforce intents in Better Auth user hooks

**Files:**
- Modify: `src/auth.ts`
- Create: `tests/helpers/auth.ts`
- Create: `tests/better-auth-oauth-hooks.test.ts`

- [ ] **Step 1: Create OAuth integration helpers**

Create `tests/helpers/auth.ts` with concrete helpers to:

- update `settings.registration_enabled`, `registration_mode`, and `invite_required`, then call `invalidateSettingsCache(db)`;
- insert provider `fixture` with `https://provider.example/authorize`, `/token`, `/userinfo`, deterministic client credentials, scopes `openid,profile,email`, `pkce = 0`, enabled;
- convert all `Set-Cookie` values to a request `Cookie` header by retaining only each `name=value` pair;
- build same-origin JSON headers with `Origin: https://app.example`, `Cookie: csrf_token=test-csrf`, `x-csrf-token: test-csrf`;
- mock `globalThis.fetch` so token endpoint returns `{"access_token":"access-token","token_type":"Bearer"}` and user-info returns `{"id":"provider-user-1","email":"oauth-user@example.test","email_verified":true,"name":"OAuth User"}`.

Use:

```ts
export async function setRegistrationPolicy(
  db: D1Database,
  input: { enabled: boolean; mode: 'email' | 'oauth' | 'both'; inviteRequired: boolean }
): Promise<void>
```

- [ ] **Step 2: Write failing hook integration tests**

Cover:

1. `auth.api.signUpEmail` still creates a sequential numeric user without an intent;
2. generic callback that creates a user rejects without an intent cookie;
3. wrong provider/state/token and expiry reject before user insertion;
4. valid intent permits user/account insertion, consumes invite, creates one session, emits a session cookie;
5. existing OAuth user signs in without an intent because no user-create hook runs;
6. `auth.api.oAuth2LinkAccount` plus callback binds an account without registration authorization;
7. a `BEFORE INSERT ON account` trigger raising `forced_account_failure` causes no session, but Better Auth 1.6.23 still runs queued `user.create.after` and the invite remains used rather than reopening;
8. forced finalization failure prevents session creation.

For case 7 query `user`, `session`, and `invite_code` and assert one user, zero sessions, non-null `used_by`, null `reserved_intent_id`. This is the executable version-pin contract.

- [ ] **Step 3: Run and confirm failure**

Run `pnpm test -- tests/better-auth-oauth-hooks.test.ts`.

Expected: missing intent does not block new OAuth user creation, or valid intents remain unconsumed.

- [ ] **Step 4: Compose hooks in `src/auth.ts`**

Import:

```ts
import { readGenericOAuthCallback } from './lib/better-auth-oauth-context'
import {
  authorizeOAuthRegistrationIntent,
  consumeAuthorizedOAuthRegistrationIntent,
  createOAuthRegistrationSecurityEvent
} from './services/oauth-registration-intents'
```

Replace the existing user-create hook with:

```ts
const logOAuthRegistrationFailure = (error: unknown, providerId: string) => {
  console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(error, { providerId })))
}

create: {
  before: async (user, context) => {
    const id = await allocateNextUserId(env.DB)
    const callback = readGenericOAuthCallback(context)
    if (callback) {
      try {
        await authorizeOAuthRegistrationIntent(env.DB, {
          token: callback.intentToken,
          providerId: callback.providerId,
          state: callback.state,
          userId: id
        })
      } catch (error) {
        logOAuthRegistrationFailure(error, callback.providerId)
        throw error
      }
    }
    return { data: { ...user, id } }
  },
  after: async (user, context) => {
    const callback = readGenericOAuthCallback(context)
    if (!callback) return
    try {
      await consumeAuthorizedOAuthRegistrationIntent(env.DB, {
        userId: user.id,
        token: callback.intentToken,
        providerId: callback.providerId,
        state: callback.state
      })
    } catch (error) {
      logOAuthRegistrationFailure(error, callback.providerId)
      throw error
    }
  }
}
```

The helper logs only the JSON-safe event and never the original error object. Email signup remains outside the generic callback and only receives numeric ID allocation. Existing OAuth login and account linking do not create a user, so the registration hook does not run.

- [ ] **Step 5: Run and commit**

```powershell
pnpm test -- tests/better-auth-oauth-hooks.test.ts
git add src/auth.ts tests/helpers/auth.ts tests/better-auth-oauth-hooks.test.ts
git commit -m "fix: enforce OAuth registration intents in auth hooks"
```

Expected: hook, existing-login, linking, account-failure, and no-session-on-finalization-failure tests pass.

---

### Task 7: Replace the plaintext invite cookie and harden OAuth routes

**Files:**
- Modify: `src/routes/auth.ts`
- Create: `tests/oauth-registration-routes.test.ts`

- [ ] **Step 1: Write route regression tests**

Using a fresh D1 and `src/index.ts`, cover:

1. `POST /api/auth/sign-in/oauth2` returns 403/code `OAUTH2_PUBLIC_ENTRY_DISABLED` even with `requestSignUp: true`;
2. `POST /api/auth/oauth/login` still returns an authorization URL and creates no intent;
3. disabled registration and `email` mode reject before intent creation;
4. missing, unknown, or disabled Provider returns the stable OAuth registration failure and retains no intent or reservation;
5. missing/invalid/used/revoked/reserved required invite returns the same stable failure and creates no retained intent;
6. successful custom registration returns an authorization URL, sets `oauth_registration_intent`, never sets `pending_invite_code`, and never puts clear invite in cookie, URL, body, or intent row;
7. stored `oauth_state_hash` corresponds to the returned URL's state and is set only after binding;
8. Better Auth URL-generation or state-binding failure deletes the pending intent and releases reservation;
9. `/register/oauth/done` with a pending fixture clears the cookie and releases that pending state without changing `consumed_at` or `invite_code.used_by`;
10. `/register/oauth/error` clears the cookie, releases only pending state, redirects with `OAUTH_REGISTRATION_FAILED`, and never reflects provider `error`/`error_description`;
11. neither completion nor error route releases authorized state; if shared cleanup observes an authorized intent whose user exists, reconciliation follows the same service-level finalization contract rather than route-specific consumption;
12. GitHub account-age rejection still uses the existing stable rejection path.

Bypass assertion:

```ts
const response = await app.request(
  'https://app.example/api/auth/sign-in/oauth2',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example' },
    body: JSON.stringify({ providerId: 'fixture', requestSignUp: true })
  },
  env
)
expect(response.status).toBe(403)
expect(await response.json()).toMatchObject({
  success: false,
  code: 'OAUTH2_PUBLIC_ENTRY_DISABLED'
})
```

- [ ] **Step 2: Run and confirm failures**

Run `pnpm test -- tests/oauth-registration-routes.test.ts`.

Expected: public endpoint remains reachable and successful registration sets `pending_invite_code`.

- [ ] **Step 3: Replace imports and delete retrospective OAuth helpers**

Remove OAuth-route use of `getGitHubUser`, `meetsAgeRequirement`, `deleteUserCascade`, `finalizeInviteUsage`, the local `inviteCookie`, and old `pending_invite_code` parsing. Keep imports only if another non-OAuth route needs them.

Import:

```ts
import {
  OAUTH_REGISTRATION_INTENT_COOKIE,
  bindOAuthRegistrationIntentState,
  buildOAuthRegistrationIntentClearCookie,
  buildOAuthRegistrationIntentCookie,
  cleanupOAuthRegistrationIntents,
  createOAuthRegistrationIntent,
  createOAuthRegistrationSecurityEvent,
  releasePendingOAuthRegistrationIntent
} from '../services/oauth-registration-intents'
```

- [ ] **Step 4: Rewrite `POST /api/auth/oauth/register`**

After existing CSRF, session, settings, provider, and input checks, remove the OAuth route's call to `requireInviteCodeIfNeeded`; the intent service now performs the definitive atomic validation/reservation. Email registration continues using `requireInviteCodeIfNeeded`. Use one stable failure response for intent, provider, and database errors:

```ts
const oauthRegistrationFailed = () =>
  apiErr(c, 'OAuth 注册失败，请重新发起注册', 400, {
    code: 'OAUTH_REGISTRATION_FAILED'
  })

let intent: Awaited<ReturnType<typeof createOAuthRegistrationIntent>> | null = null
try {
  await cleanupOAuthRegistrationIntents(c.env.DB).catch((error) => {
    console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(error, { providerId })))
  })
  intent = await createOAuthRegistrationIntent(c.env.DB, {
    providerId,
    inviteRequired: settings.invite_required,
    inviteCode
  })

  const res = await (auth.api as any).signInWithOAuth2({
    body: {
      providerId,
      callbackURL: '/register/oauth/done',
      errorCallbackURL: '/register/oauth/error',
      requestSignUp: true
    },
    headers: c.req.raw.headers,
    asResponse: true
  })
  const extracted = await extractOAuthRedirectUrl(res)
  if (!extracted.url) throw new Error('oauth_redirect_missing')

  const authorization = new URL(extracted.url)
  const state = authorization.searchParams.get('state') || ''
  if (!state) throw new Error('oauth_state_missing')
  await bindOAuthRegistrationIntentState(c.env.DB, {
    id: intent.id,
    token: intent.token,
    providerId,
    state
  })

  const headers = new Headers(extracted.headers)
  headers.append(
    'Set-Cookie',
    buildOAuthRegistrationIntentCookie(intent.token, requestIsHttps(c.req.raw))
  )
  return apiOkWithHeaders(undefined, headers, { redirect: extracted.url })
} catch (error) {
  console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(error, {
    providerId
  })))
  if (intent) {
    await releasePendingOAuthRegistrationIntent(c.env.DB, intent.token).catch((releaseError) => {
      console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(releaseError, {
        providerId
      })))
    })
  }
  return oauthRegistrationFailed()
}
```

Never log the original error, return the underlying exception, expose a token before state binding succeeds, or set the old invite cookie.

- [ ] **Step 5: Replace `/register/oauth/done`**

Replace the route with the following cleanup-only sequence:

```ts
app.get('/register/oauth/done', async (c) => {
  const user = await getCurrentUser(c.env, c.req.raw.headers)
  const token = parseCookie(
    c.req.header('Cookie') || '',
    OAUTH_REGISTRATION_INTENT_COOKIE
  )
  await releasePendingOAuthRegistrationIntent(c.env.DB, token).catch((error) => {
    console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(error, {
      providerId: 'unknown'
    })))
  })
  await cleanupOAuthRegistrationIntents(c.env.DB).catch((error) => {
    console.error(JSON.stringify(createOAuthRegistrationSecurityEvent(error, {
      providerId: 'unknown'
    })))
  })
  const headers = new Headers({
    'Set-Cookie': buildOAuthRegistrationIntentClearCookie(requestIsHttps(c.req.raw))
  })
  return user
    ? redirectWithHeaders('/', 302, headers)
    : redirectWithHeaders(
        '/login?error=' + encodeURIComponent('OAuth 注册失败，请重新发起注册'),
        302,
        headers
      )
})
```

It must not inspect `user.createdAt`, re-check registration policy, call GitHub, delete users, directly consume invites, or infer newness. Any authorized reconciliation remains inside the shared cleanup service rather than completion-route logic. Each failure path logs only the serialized security event, continues clearing the cookie, and never logs the original error.

- [ ] **Step 6: Add `/register/oauth/error`**

Read the intent cookie, run the same two independently guarded calls shown in Step 5, and build the same clear-cookie header. Ignore every provider query value, never log the original error, and return exactly:

```ts
return redirectWithHeaders(
  '/register?error=' +
    encodeURIComponent('OAuth 注册失败，请重新发起注册') +
    '&code=OAUTH_REGISTRATION_FAILED',
  302,
  headers
)
```

Do not read or reflect `error`, `error_description`, `code`, or any other Provider query parameter.

- [ ] **Step 7: Block public generic OAuth sign-in**

Before `auth.handler`, normalize:

```ts
const authSubpath = pathname
  .replace(/^\/api\/auth/, '')
  .replace(/\/+$/, '') || '/'
```

Reject:

```ts
if (method === 'POST' && authSubpath === '/sign-in/oauth2') {
  return apiErr(c, '请通过网站登录或注册入口使用 OAuth', 403, {
    code: 'OAUTH2_PUBLIC_ENTRY_DISABLED'
  })
}
```

Keep the email sign-up block and GitHub age-error translation. Server-side `auth.api.signInWithOAuth2` and `auth.api.oAuth2LinkAccount` do not traverse the catch-all.

- [ ] **Step 8: Run and commit**

```powershell
pnpm test -- tests/oauth-registration-routes.test.ts tests/better-auth-oauth-hooks.test.ts
git add src/routes/auth.ts tests/oauth-registration-routes.test.ts
git commit -m "fix: secure OAuth invite registration routes"
```

Expected: public bypass is blocked and custom login/register, existing login, and linking remain functional.

---

### Task 8: Lock race and session-order guarantees

**Files:**
- Modify: `tests/oauth-registration-intents.test.ts`
- Modify: `tests/better-auth-oauth-hooks.test.ts`

- [ ] **Step 1: Add authorized cleanup race coverage**

Reproduce the stale-authorized conditional mutation around a competing user insert. Assert repeated `NOT EXISTS` predicates prevent release once the user appears, and the next public cleanup finalizes consumption:

```ts
expect(await readIntent(db, intent.id)).toMatchObject({ consumed_at: null })
expect(await readInvite(db, invite.id)).toMatchObject({
  reserved_intent_id: intent.id,
  used_by: null
})
await cleanupOAuthRegistrationIntents(
  db,
  now + OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS + 2
)
expect(await readIntent(db, intent.id)).toMatchObject({ consumed_at: expect.any(Number) })
expect(await readInvite(db, invite.id)).toMatchObject({
  reserved_intent_id: null,
  used_by: userId
})
```

Do not add a production pause hook. The test issues the same conditional D1 mutation around the competing insert, then uses public cleanup for reconciliation.

- [ ] **Step 2: Prove finalization precedes session insertion**

In the successful callback test, install:

```sql
CREATE TRIGGER assert_oauth_intent_consumed_before_session
BEFORE INSERT ON session
WHEN EXISTS (
  SELECT 1 FROM oauth_registration_intent
  WHERE authorized_user_id = NEW.userId
)
AND NOT EXISTS (
  SELECT 1 FROM oauth_registration_intent
  WHERE authorized_user_id = NEW.userId
    AND consumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'oauth_intent_not_consumed_before_session');
END;
```

The callback must still succeed. This proves session security does not depend on the completion page.

- [ ] **Step 3: Repeat the suite**

```powershell
1..5 | ForEach-Object { pnpm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Expected: five consecutive passes without a concurrency flake.

- [ ] **Step 4: Commit**

```powershell
git add tests/oauth-registration-intents.test.ts tests/better-auth-oauth-hooks.test.ts
git commit -m "test: lock OAuth intent race guarantees"
```

---

### Task 9: Final type, migration, build, privacy, and diff verification

**Files:**
- Verify all files changed in Tasks 1-8

- [ ] **Step 1: Run all tests**

Run `pnpm test`.

Expected: all tests pass.

- [ ] **Step 2: Run strict TypeScript checking**

Run `pnpm exec tsc --noEmit`.

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Validate the complete migration sequence**

Run:

```powershell
pnpm test -- tests/oauth-registration-intents.test.ts -t "0010 OAuth registration intent migration"
```

Expected: migrations `0000` through `0010` and trigger tests pass on fresh Miniflare D1.

- [ ] **Step 4: Run Wrangler dry-run**

```powershell
pnpm exec wrangler deploy --dry-run --outdir .wrangler-dry-run
```

Expected: successful bundle without publishing. Then remove only the verified repository-local output:

```powershell
$target = (Resolve-Path -LiteralPath '.wrangler-dry-run').Path
$root = (Resolve-Path -LiteralPath '.').Path
if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Refusing to remove path outside repository'
}
Remove-Item -LiteralPath $target -Recurse -Force
```

- [ ] **Step 5: Verify the old boundary and plaintext cookie are gone**

```powershell
rg -n "pending_invite_code|inviteCookie\(" src
rg -n "getGitHubUser\(|meetsAgeRequirement\(|finalizeInviteUsage\(c\.env\.DB, pendingInvite" src/routes/auth.ts
```

Expected: no production-source matches. Tests may name `pending_invite_code` only to prove it is absent from responses. Ordinary email-flow `finalizeInviteUsage`/`deleteUserCascade` calls and the GitHub Provider service's age-check helpers remain valid outside the removed OAuth completion-page logic.

```powershell
rg -n "oauth_registration_intent|OAUTH2_PUBLIC_ENTRY_DISABLED|OAUTH_REGISTRATION_FAILED" src tests migrations
```

Expected: matches only in the new service, hook, route, tests, and migration.

- [ ] **Step 6: Perform privacy-oriented diff checks without opening `.dev.vars`**

Use the approved design commit as the immutable review base so committed changes are included:

```powershell
$base = '2ac8425'
git status --short
git diff --check "$base..HEAD"
git diff --name-only "$base..HEAD"
git diff "$base..HEAD" -- . ':(exclude).dev.vars' ':(exclude)docs/**' ':(exclude)tests/**' |
  Select-String -Pattern 'client_secret\s*[=:]\s*["''][^"'']+|(?:access|refresh|id)[_-]?token\s*[=:]\s*["''][A-Za-z0-9._-]{20,}|pending_invite_code=[^;[:space:]]+'
```

Expected: the worktree is clean; `.dev.vars` is absent from all paths changed since `2ac8425`; the committed diff passes whitespace checks; and production code contains no credential-shaped value or old plaintext cookie assignment. Obvious test fixtures are allowed only inside tests and must never be copied to logs or responses. Do not read `.dev.vars`.

- [ ] **Step 7: Review security invariants**

Confirm from code and tests:

- public `POST /api/auth/sign-in/oauth2` is rejected;
- only app-owned server calls initiate OAuth login/register/link;
- token and OAuth state are hashed at rest;
- clear invites are absent from browser cookies;
- callback provider/state/token/expiry/current policy are checked before user insertion;
- final consumption occurs before session insertion;
- pending deletion may release, authorized deletion cannot release accidentally;
- reconciliation honors one-hour quarantine and repeated user-existence checks;
- completion/error are cleanup-only and do not authorize;
- existing login and account linking need no registration intent;
- Better Auth is pinned at 1.6.23 and its D1 hook behavior has a contract test.

- [ ] **Step 8: Verify the non-destructive rollback and incident path**

Confirm the migration contains only additive `CREATE`/`ALTER` operations and no `DROP TABLE`, `DROP COLUMN`, or destructive rollback. Record and rehearse this rollback order without reverting the public endpoint block:

1. set `settings.registration_mode = 'email'` (or disable registration entirely) to stop OAuth new-user creation while leaving existing OAuth login and account linking available;
2. deploy only a last-known-good hook/service revision that still rejects public `POST /api/auth/sign-in/oauth2`; never restore the native public sign-up path;
3. keep `oauth_registration_intent` and the `invite_code` reservation columns in place during code rollback;
4. release only pending intents through `releasePendingOAuthRegistrationIntent` or normal expiry cleanup;
5. reconcile authorized intents by user existence and the one-hour quarantine rules before any release; never bulk-delete or directly clear their reservations.

Run:

```powershell
rg -n "DROP TABLE|DROP COLUMN" migrations/0010_oauth_registration_intents.sql
rg -n "OAUTH2_PUBLIC_ENTRY_DISABLED|/sign-in/oauth2" src/routes/auth.ts tests/oauth-registration-routes.test.ts
```

Expected: the migration scan has no matches, and the route/test scan proves the public blocker remains an explicit rollback invariant.

- [ ] **Step 9: Record a clean final state**

If corrections were needed, commit each narrowly and rerun Steps 1-8. Then run:

```powershell
git status --short
git log --oneline -12
```

Expected: clean worktree and small commits for test setup, schema, invite compatibility, service, context parser, hooks, routes, and race contracts.

---

## Acceptance evidence for整改项 1

Do not report整改项 1 complete until all evidence exists:

1. `pnpm test` passes, including direct bypass regression.
2. `pnpm exec tsc --noEmit` exits 0.
3. Wrangler dry-run bundles successfully.
4. D1 concurrency proves one invite is reserved by only one intent.
5. Trigger tests prove `consumed_at` and invite ownership update atomically.
6. Better Auth account-insert failure creates no session and never reopens the invite.
7. Session trigger proves intent consumption precedes session insertion.
8. Quarantine tests prove authorized intents are neither released early nor stranded when user exists.
9. Completion/error tests prove cleanup-only behavior and no provider-error reflection.
10. Final diff contains no `.dev.vars` content, clear token, clear invite cookie, authorization code, or OAuth access/refresh/id token.

After these checks pass, report整改项 1 complete, keep the overall 15-item goal active, and proceed to整改项 2: first-setup claim and concurrency.
