# External Service Error Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redact DNS and mail external-service failures from browser-visible responses while preserving safe operational signals through allowlisted security events.

**Architecture:** Add a small shared external-service security boundary, then classify Cloudflare DNS and Resend failures into program-readable result/error shapes. Routes convert those internal classifications into fixed client messages and log only allowlisted event fields.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers D1, Vitest, Miniflare, Better Auth `1.6.23`, `@better-auth/passkey` `1.6.23`.

---

## File structure

- Create `tests/external-service-redaction-routes.test.ts`
  - Route-level regression coverage for DNS create/update/delete, DNS config gaps, mail test failure/success, and allowlisted security logs.
- Create `src/lib/external-service-security.ts`
  - Shared constants, safe client-message mapping, event serializers, and logging helpers.
- Modify `src/services/cloudflare-dns.ts`
  - Replace raw Cloudflare message throws with `CloudflareDnsError` classifications.
  - Add stage-aware request handling.
  - Log cleanup/delete failures without leaking third-party bodies.
- Modify `src/routes/dns.tsx`
  - Replace raw `err.message` responses and config-key responses with fixed safe DNS messages for `POST /api/create-dns` and `POST /api/dns/:id/update`.
  - Wrap `POST /api/dns/:id/delete` in the same safe DNS boundary.
- Modify `src/routes/admin.ts`
  - Wrap admin DNS deletion paths in safe DNS responses.
  - Map mail test results to fixed messages and remove recipient email echo.
- Modify `src/services/mailer.ts`
  - Replace free-text Resend failure aggregation with typed result codes, status, retry flags, and account indexes.
  - Ensure returned `message` values are safe if retained for compatibility.
- Verification only:
  - `package.json` and `pnpm-lock.yaml` must keep Better Auth versions unchanged.

---

### Task 1: Add failing external-service redaction route tests

**Files:**
- Create: `tests/external-service-redaction-routes.test.ts`
- Read: `tests/helpers/d1.ts`
- Read: `tests/helpers/auth.ts`
- Read: `src/index.ts`

- [ ] **Step 1: Create the failing regression test file**

Create `tests/external-service-redaction-routes.test.ts` with the following structure. Keep the private strings deliberately distinctive so a leaked response or log is obvious.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from 'better-auth/crypto'
import app from '../src/index'
import { createAuth } from '../src/auth'
import { insertRecord } from '../src/services/dns-records'
import { updateSettings } from '../src/services/settings'
import type { Bindings } from '../src/services/cloudflare-dns'
import {
  createTestD1,
  disposeTestD1Instances,
  markFirstSetupCompleted,
  seedUser,
  type TestD1
} from './helpers/d1'
import {
  AUTH_ORIGIN,
  cookiesFromHeaders,
  sameOriginJsonHeaders
} from './helpers/auth'

const instances: TestD1[] = []

const PRIVATE_VALUES = [
  'CF_PRIVATE_BODY',
  'RESEND_PRIVATE_BODY',
  'cf-secret-token',
  'resend-secret-key',
  'example_test_CLOUDFLARE_API_TOKEN',
  'DOMAINS',
  'sender-private@example.test',
  'recipient-private@example.test',
  'private-cookie',
  '203.0.113.44',
  'private-user-agent',
  'private-stack'
]

async function setup(extraEnv: Partial<Bindings> = {}) {
  const instance = await createTestD1()
  instances.push(instance)
  await markFirstSetupCompleted(instance.db)
  await seedUser(instance.db, {
    id: 'admin-user',
    email: 'admin@example.test',
    name: 'Fixture Admin'
  })
  const env = {
    DB: instance.db,
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: AUTH_ORIGIN,
    APP_NAME: 'Test App',
    DOMAINS: 'example.test',
    example_test_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
    ...extraEnv
  } as unknown as Bindings
  return { db: instance.db, env }
}

async function adminHeaders(db: D1Database, env: Bindings): Promise<Headers> {
  const password = 'password123'
  const now = Date.now()
  await db.prepare(
    `INSERT INTO account
     (id, accountId, providerId, userId, password, createdAt, updatedAt)
     VALUES (?, ?, 'credential', ?, ?, ?, ?)`
  ).bind(
    'admin-user-credential',
    'admin-user',
    'admin-user',
    await hashPassword(password),
    now,
    now
  ).run()
  const auth = await createAuth(env)
  const signIn = await auth.api.signInEmail({
    headers: sameOriginJsonHeaders(),
    body: { email: 'admin@example.test', password },
    asResponse: true
  })
  expect(signIn.status).toBe(200)
  return sameOriginJsonHeaders(`csrf_token=test-csrf; ${cookiesFromHeaders(signIn.headers)}`)
}

async function postJson(
  env: Bindings,
  path: string,
  body: Record<string, unknown>,
  headers: Headers
): Promise<Response> {
  return await app.request(`${AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, env)
}

async function seedDnsRecord(db: D1Database, userId = 'admin-user') {
  return await insertRecord(db, {
    id: 'record-one',
    user_id: userId,
    root_domain: 'example.test',
    subdomain: 'play',
    host_name: 'play.example.test',
    server_address: '198.51.100.10',
    port: 25565,
    target_type: 'A',
    target_record_id: 'target-record-id',
    srv_record_id: 'srv-record-id'
  })
}

function mockCloudflareFailure(failingMethod: 'POST' | 'PUT' | 'DELETE') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const method = String(init?.method ?? 'GET').toUpperCase()
    if (url.includes('/zones?')) {
      return Response.json({ success: true, result: [{ id: 'zone-id' }] })
    }
    if (url.includes('/dns_records?')) {
      return Response.json({ success: true, result: [] })
    }
    if (method === failingMethod) {
      return Response.json({
        success: false,
        errors: [{ message: 'CF_PRIVATE_BODY cf-secret-token example_test_CLOUDFLARE_API_TOKEN private-stack' }]
      }, { status: 500 })
    }
    return Response.json({ success: true, result: { id: `${method.toLowerCase()}-record-id` } })
  })
}

function mockResendFailure() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    if (url === 'https://api.resend.com/emails') {
      return new Response(
        JSON.stringify({
          message: 'RESEND_PRIVATE_BODY resend-secret-key sender-private@example.test recipient-private@example.test'
        }),
        { status: 422, headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response('not found', { status: 404 })
  })
}

function assertNoPrivateText(text: string) {
  for (const value of PRIVATE_VALUES) {
    expect(text).not.toContain(value)
  }
}

function parsedSecurityEvents(errorSpy: ReturnType<typeof vi.spyOn>) {
  return errorSpy.mock.calls.map((call) => {
    expect(call).toHaveLength(1)
    return JSON.parse(String(call[0])) as Record<string, unknown>
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeTestD1Instances(instances)
})

describe('external service error redaction', { timeout: 60_000 }, () => {
  it('redacts DNS config details from create responses', async () => {
    const { db, env } = await setup({ DOMAINS: '' } as Partial<Bindings>)
    const headers = await adminHeaders(db, env)
    const response = await postJson(env, '/api/create-dns', {
      subdomain: 'play',
      rootDomain: 'example.test',
      serverAddress: '198.51.100.10',
      port: 25565
    }, headers)
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).toContain('DNS 閰嶇疆鏆備笉鍙敤锛岃鑱旂郴绠＄悊鍛?)
    assertNoPrivateText(text)
  })

  it('redacts and logs Cloudflare create failures', async () => {
    const { db, env } = await setup()
    const headers = await adminHeaders(db, env)
    mockCloudflareFailure('POST')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await postJson(env, '/api/create-dns', {
      subdomain: 'play',
      rootDomain: 'example.test',
      serverAddress: '198.51.100.10',
      port: 25565
    }, headers)
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).toContain('DNS 鏈嶅姟鏆傛椂涓嶅彲鐢紝璇风◢鍚庨噸璇?)
    assertNoPrivateText(text)
    const events = parsedSecurityEvents(errorSpy)
    expect(events.some((event) => event.event === 'dns_external_service_failed')).toBe(true)
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['code', 'event', 'retriable', 'service', 'stage', 'status', 'timestamp'])
      expect(event.service).toBe('cloudflare_dns')
      assertNoPrivateText(JSON.stringify(event))
    }
  })

  it('redacts Cloudflare update and delete failures', async () => {
    const { db, env } = await setup()
    const headers = await adminHeaders(db, env)
    await seedDnsRecord(db)

    mockCloudflareFailure('PUT')
    const updateResponse = await postJson(env, '/api/dns/record-one/update', {
      serverAddress: '198.51.100.11',
      port: 25566
    }, headers)
    const updateText = await updateResponse.text()
    expect(updateResponse.status).toBe(500)
    expect(updateText).toContain('DNS 鏈嶅姟鏆傛椂涓嶅彲鐢紝璇风◢鍚庨噸璇?)
    assertNoPrivateText(updateText)

    vi.restoreAllMocks()
    mockCloudflareFailure('DELETE')
    const deleteErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const deleteResponse = await postJson(env, '/api/dns/record-one/delete', {}, headers)
    const deleteText = await deleteResponse.text()
    expect(deleteResponse.status).toBe(200)
    expect(deleteText).toContain('璁板綍宸插垹闄?)
    assertNoPrivateText(deleteText)
    const events = parsedSecurityEvents(deleteErrorSpy)
    expect(events.some((event) => event.stage === 'record_delete')).toBe(true)
    for (const event of events) assertNoPrivateText(JSON.stringify(event))
  })

  it('redacts Resend failures and logs allowlisted mail events', async () => {
    const { db, env } = await setup()
    const headers = await adminHeaders(db, env)
    await updateSettings(db, {
      resend_enabled: true,
      resend_accounts: [{ api_key: 'resend-secret-key', from: 'sender-private@example.test' }]
    })
    mockResendFailure()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await postJson(env, '/api/admin/mail/test', {
      to_email: 'recipient-private@example.test'
    }, headers)
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).toContain('娴嬭瘯閭欢鍙戦€佸け璐ワ紝璇锋鏌ラ偖浠堕厤缃悗閲嶈瘯')
    assertNoPrivateText(text)
    const events = parsedSecurityEvents(errorSpy)
    expect(events.some((event) => event.event === 'mail_external_service_failed')).toBe(true)
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['account_index', 'code', 'event', 'retriable', 'service', 'stage', 'status', 'timestamp'])
      expect(event.service).toBe('resend')
      assertNoPrivateText(JSON.stringify(event))
    }
  })

  it('does not echo recipient email after successful test mail submission', async () => {
    const { db, env } = await setup()
    const headers = await adminHeaders(db, env)
    await updateSettings(db, {
      resend_enabled: true,
      resend_accounts: [{ api_key: 'resend-secret-key', from: 'sender-private@example.test' }]
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'mail-id' }))

    const response = await postJson(env, '/api/admin/mail/test', {
      to_email: 'recipient-private@example.test'
    }, headers)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('娴嬭瘯閭欢宸叉彁浜ゅ彂閫?)
    assertNoPrivateText(text)
  })
})
```

- [ ] **Step 2: Run the new tests and verify they fail against the current implementation**

Run:

```powershell
pnpm exec vitest run tests/external-service-redaction-routes.test.ts --reporter=dot
```

Expected: failing tests. At least the DNS config, Cloudflare create/update, Resend failure, or mail success email-echo assertions must fail because current routes expose raw details or echo the recipient email.

- [ ] **Step 3: Commit the failing regression tests**

```powershell
git add tests/external-service-redaction-routes.test.ts
git commit -m "test: cover external service response redaction"
```

---

### Task 2: Add shared external-service security helpers

**Files:**
- Create: `src/lib/external-service-security.ts`
- Test: `tests/external-service-redaction-routes.test.ts`

- [ ] **Step 1: Create the shared helper module**

Create `src/lib/external-service-security.ts`:

```ts
export type DnsExternalFailureCode =
  | 'DNS_CONFIG_MISSING'
  | 'CLOUDFLARE_REQUEST_FAILED'
  | 'CLOUDFLARE_ZONE_NOT_FOUND'
  | 'DNS_EXTERNAL_FAILURE'

export type DnsExternalFailureStage =
  | 'config'
  | 'zone_lookup'
  | 'record_lookup'
  | 'record_create'
  | 'record_update'
  | 'record_delete'
  | 'cleanup'

export type MailExternalFailureCode =
  | 'MAIL_CONFIG_MISSING'
  | 'MAIL_DISABLED'
  | 'MAIL_INVALID_RECIPIENT'
  | 'RESEND_REQUEST_FAILED'
  | 'MAIL_NETWORK_FAILURE'
  | 'MAIL_ALL_ACCOUNTS_FAILED'

export type MailExternalFailureStage =
  | 'config'
  | 'recipient_validation'
  | 'send'

export const DNS_CONFIG_SAFE_MESSAGE = 'DNS 閰嶇疆鏆備笉鍙敤锛岃鑱旂郴绠＄悊鍛?
export const DNS_EXTERNAL_SAFE_MESSAGE = 'DNS 鏈嶅姟鏆傛椂涓嶅彲鐢紝璇风◢鍚庨噸璇?
export const DNS_GENERIC_SAFE_MESSAGE = 'DNS 璇锋眰澶勭悊澶辫触锛岃绋嶅悗閲嶈瘯'
export const MAIL_CONFIG_SAFE_MESSAGE = '閭欢閰嶇疆鏆備笉鍙敤锛岃妫€鏌ュ悗鍙伴厤缃?
export const MAIL_SEND_SAFE_MESSAGE = '娴嬭瘯閭欢鍙戦€佸け璐ワ紝璇锋鏌ラ偖浠堕厤缃悗閲嶈瘯'
export const MAIL_TEST_SUCCESS_MESSAGE = '娴嬭瘯閭欢宸叉彁浜ゅ彂閫?

export type DnsExternalFailureEventInput = {
  code: DnsExternalFailureCode
  stage: DnsExternalFailureStage
  status?: number
  retriable?: boolean
}

export type MailExternalFailureEventInput = {
  code: MailExternalFailureCode
  stage: MailExternalFailureStage
  status?: number
  accountIndex?: number
  retriable?: boolean
}

function finiteStatus(status: number | undefined): number | undefined {
  return Number.isFinite(status) ? Math.trunc(status as number) : undefined
}

export function createDnsExternalServiceSecurityEvent(input: DnsExternalFailureEventInput) {
  return {
    event: 'dns_external_service_failed',
    code: input.code,
    stage: input.stage,
    service: 'cloudflare_dns',
    status: finiteStatus(input.status),
    retriable: !!input.retriable,
    timestamp: Date.now()
  }
}

export function createMailExternalServiceSecurityEvent(input: MailExternalFailureEventInput) {
  return {
    event: 'mail_external_service_failed',
    code: input.code,
    stage: input.stage,
    service: 'resend',
    status: finiteStatus(input.status),
    account_index: Number.isFinite(input.accountIndex) ? Math.trunc(input.accountIndex as number) : undefined,
    retriable: !!input.retriable,
    timestamp: Date.now()
  }
}

export function logDnsExternalServiceFailure(input: DnsExternalFailureEventInput): void {
  console.error(JSON.stringify(createDnsExternalServiceSecurityEvent(input)))
}

export function logMailExternalServiceFailure(input: MailExternalFailureEventInput): void {
  console.error(JSON.stringify(createMailExternalServiceSecurityEvent(input)))
}

export function safeDnsClientMessage(code: DnsExternalFailureCode): string {
  return code === 'DNS_CONFIG_MISSING'
    ? DNS_CONFIG_SAFE_MESSAGE
    : DNS_EXTERNAL_SAFE_MESSAGE
}

export function safeMailTestClientMessage(code: MailExternalFailureCode): string {
  if (code === 'MAIL_CONFIG_MISSING' || code === 'MAIL_DISABLED') {
    return MAIL_CONFIG_SAFE_MESSAGE
  }
  return MAIL_SEND_SAFE_MESSAGE
}
```

- [ ] **Step 2: Run type checking for the new helper**

Run:

```powershell
pnpm exec tsc --noEmit
```

Expected: pass or only fail because subsequent tasks have not yet integrated planned types. If it fails now, fix export/type syntax before continuing.

- [ ] **Step 3: Commit the helper module**

```powershell
git add src/lib/external-service-security.ts
git commit -m "feat: add external service security events"
```

---

### Task 3: Classify Cloudflare DNS failures and make DNS routes safe

**Files:**
- Modify: `src/services/cloudflare-dns.ts`
- Modify: `src/routes/dns.tsx`
- Modify: `src/routes/admin.ts`
- Test: `tests/external-service-redaction-routes.test.ts`

- [ ] **Step 1: Add Cloudflare DNS error types and stage-aware request handling**

In `src/services/cloudflare-dns.ts`, import DNS security types and helpers:

```ts
import {
  logDnsExternalServiceFailure,
  type DnsExternalFailureCode,
  type DnsExternalFailureStage
} from '../lib/external-service-security'
```

Add the classified error near the top:

```ts
export class CloudflareDnsError extends Error {
  readonly code: DnsExternalFailureCode
  readonly stage: DnsExternalFailureStage
  readonly status?: number
  readonly retriable: boolean

  constructor(input: {
    code: DnsExternalFailureCode
    stage: DnsExternalFailureStage
    status?: number
    retriable?: boolean
  }) {
    super(input.code)
    this.name = 'CloudflareDnsError'
    this.code = input.code
    this.stage = input.stage
    this.status = input.status
    this.retriable = !!input.retriable
  }
}

export function isCloudflareDnsError(error: unknown): error is CloudflareDnsError {
  return error instanceof CloudflareDnsError
}

function isRetriableCloudflareStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}
```

Change `sendCloudflareRequest` to accept a stage and throw only the classified error:

```ts
async function sendCloudflareRequest<T>(
  token: string,
  url: string,
  init: RequestInit = {},
  stage: DnsExternalFailureStage
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    ...init,
    headers
  })
  const text = await response.text()
  const data = parseJsonResponse<T>(text)

  if (!response.ok) {
    throw new CloudflareDnsError({
      code: 'CLOUDFLARE_REQUEST_FAILED',
      stage,
      status: response.status,
      retriable: isRetriableCloudflareStatus(response.status)
    })
  }

  return data
}
```

Update every caller to pass a stage:

```ts
const data = await sendCloudflareRequest<CloudflareListResult<CloudflareZone>>(token, url, {}, 'zone_lookup')
const data = await sendCloudflareRequest<CloudflareListResult<CloudflareDnsRecord>>(token, url, {}, 'record_lookup')
const data = await sendCloudflareRequest<CloudflareSingleResult<CloudflareDnsRecord>>(token, url, {
  method: 'PUT',
  body: JSON.stringify(body)
}, 'record_update')
const data = await sendCloudflareRequest<CloudflareSingleResult<CloudflareDnsRecord>>(token, url, {
  method: 'POST',
  body: JSON.stringify(body)
}, 'record_create')
await sendCloudflareRequest(token, url, { method: 'DELETE' }, 'record_delete')
```

Replace the raw success-false throws:

```ts
if (!data.success) {
  throw new CloudflareDnsError({ code: 'DNS_EXTERNAL_FAILURE', stage: 'record_lookup' })
}
```

Use matching stages for create and update. In `fetchZoneId`, replace the raw domain-containing error:

```ts
throw new CloudflareDnsError({ code: 'CLOUDFLARE_ZONE_NOT_FOUND', stage: 'zone_lookup' })
```

- [ ] **Step 2: Log DNS cleanup/delete failures without changing delete semantics**

Modify `deleteRecordAndCloudflare` so Cloudflare cleanup failures are logged, but the DB row is still deleted as before:

```ts
export async function deleteRecordAndCloudflare(
  env: Bindings,
  record: DnsRecordRow
): Promise<void> {
  const token = getCloudflareApiToken(env, record.root_domain)
  if (!token) {
    logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'record_delete' })
    await deleteRecordRow(env.DB, record.id)
    return
  }

  try {
    const zoneId = await fetchZoneId(token, record.root_domain)
    await deleteCloudflareDnsRecord(token, zoneId, record.target_record_id).catch((error) => {
      logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
    })
    if (record.srv_record_id) {
      await deleteCloudflareDnsRecord(token, zoneId, record.srv_record_id).catch((error) => {
        logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
      })
    }
  } catch (error) {
    logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
  }

  await deleteRecordRow(env.DB, record.id)
}
```

Add this helper in the same file and export it for routes:

```ts
export function toDnsFailureEvent(
  error: unknown,
  fallbackStage: DnsExternalFailureStage
) {
  if (isCloudflareDnsError(error)) {
    return {
      code: error.code,
      stage: error.stage,
      status: error.status,
      retriable: error.retriable
    }
  }
  return {
    code: 'DNS_EXTERNAL_FAILURE' as const,
    stage: fallbackStage,
    retriable: false
  }
}
```

Modify `cleanupCloudflareDnsRecords` to log cleanup failures:

```ts
export async function cleanupCloudflareDnsRecords(
  token: string,
  zoneId: string,
  recordIds: Array<string | null | undefined>
): Promise<void> {
  const unique = [...new Set(recordIds.filter((id): id is string => !!id))]
  await Promise.all(unique.map((id) => deleteCloudflareDnsRecord(token, zoneId, id).catch((error) => {
    logDnsExternalServiceFailure(toDnsFailureEvent(error, 'cleanup'))
  })))
}
```

- [ ] **Step 3: Replace DNS route raw responses with fixed messages**

In `src/routes/dns.tsx`, import:

```ts
import {
  DNS_CONFIG_SAFE_MESSAGE,
  DNS_GENERIC_SAFE_MESSAGE,
  logDnsExternalServiceFailure,
  safeDnsClientMessage
} from '../lib/external-service-security'
```

Also import `toDnsFailureEvent` from `../services/cloudflare-dns`.

Add a local response helper above `registerDnsRoutes`:

```ts
function dnsExternalErrorResponse(c: any, error: unknown, fallbackStage: Parameters<typeof toDnsFailureEvent>[1]) {
  const event = toDnsFailureEvent(error, fallbackStage)
  logDnsExternalServiceFailure(event)
  return c.json({ success: false, message: safeDnsClientMessage(event.code) }, 500)
}
```

Replace the `domains.length === 0` response:

```ts
if (domains.length === 0) {
  logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'config' })
  return c.json({ success: false, message: DNS_CONFIG_SAFE_MESSAGE }, 500)
}
```

Replace missing token responses in create and update:

```ts
if (!token) {
  logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'config' })
  return c.json({ success: false, message: DNS_CONFIG_SAFE_MESSAGE }, 500)
}
```

Replace create catch:

```ts
} catch (err) {
  return dnsExternalErrorResponse(c, err, 'record_create')
}
```

Replace update catch:

```ts
} catch (err) {
  return dnsExternalErrorResponse(c, err, 'record_update')
}
```

Wrap `/api/dns/:id/delete` in a safe catch:

```ts
app.post('/api/dns/:id/delete', async (c) => {
  try {
    const session = await getCurrentSession(c.env, c.req.raw.headers)
    if (!session) {
      return c.json({ success: false, message: '鏈櫥褰曪紝璇峰厛鐧诲綍' }, 401)
    }
    const csrfDenied = await requireDnsMutationAuth(c)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const record = await findRecordById(c.env.DB, id)
    if (!record) {
      return c.json({ success: false, message: '璁板綍涓嶅瓨鍦? }, 404)
    }
    if (record.user_id !== session.user.id) {
      return c.json({ success: false, message: '鏃犳潈鍒犻櫎璇ヨ褰? }, 403)
    }
    await deleteRecordAndCloudflare(c.env, record)
    const currentCount = await countRecordsByUser(c.env.DB, session.user.id)
    const settings = await getSettings(c.env.DB)
    const userRow = await findUserById(c.env.DB, session.user.id)
    const recordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
    return c.json({
      success: true,
      message: '璁板綍宸插垹闄?,
      id,
      record_count: currentCount,
      record_limit: recordLimit
    })
  } catch (err) {
    logDnsExternalServiceFailure(toDnsFailureEvent(err, 'record_delete'))
    return c.json({ success: false, message: DNS_GENERIC_SAFE_MESSAGE }, 500)
  }
})
```

- [ ] **Step 4: Wrap admin DNS deletion paths safely**

In `src/routes/admin.ts`, import:

```ts
import {
  DNS_GENERIC_SAFE_MESSAGE,
  logDnsExternalServiceFailure
} from '../lib/external-service-security'
import { deleteRecordAndCloudflare, toDnsFailureEvent, type Bindings } from '../services/cloudflare-dns'
```

For `POST /api/admin/users/:id/delete`, wrap the record cleanup loop:

```ts
try {
  const records = await listRecordsByUser(c.env.DB, id)
  for (const r of records) {
    await deleteRecordAndCloudflare(c.env, r)
  }
  await deleteUserCascade(c.env.DB, id)
  return apiOk(c, undefined, { message: "鐢ㄦ埛宸插垹闄? })
} catch (err) {
  logDnsExternalServiceFailure(toDnsFailureEvent(err, 'record_delete'))
  return apiErr(c, DNS_GENERIC_SAFE_MESSAGE, 500)
}
```

For `POST /api/admin/dns/:id/delete`, wrap the deletion:

```ts
try {
  const id = c.req.param('id')
  const record = await findRecordById(c.env.DB, id)
  if (record) {
    await deleteRecordAndCloudflare(c.env, record)
  }
  return apiOk(c, undefined, { message: "DNS 璁板綍宸插垹闄? })
} catch (err) {
  logDnsExternalServiceFailure(toDnsFailureEvent(err, 'record_delete'))
  return apiErr(c, DNS_GENERIC_SAFE_MESSAGE, 500)
}
```

- [ ] **Step 5: Run DNS-focused regression tests**

Run:

```powershell
pnpm exec vitest run tests/external-service-redaction-routes.test.ts --reporter=dot
```

Expected after this task: DNS tests pass. Mail tests may still fail until Task 4.

- [ ] **Step 6: Commit DNS classification and route redaction**

```powershell
git add src/services/cloudflare-dns.ts src/routes/dns.tsx src/routes/admin.ts
git commit -m "fix: redact dns external service errors"
```

---

### Task 4: Classify Resend failures and make mail test responses safe

**Files:**
- Modify: `src/services/mailer.ts`
- Modify: `src/routes/admin.ts`
- Test: `tests/external-service-redaction-routes.test.ts`

- [ ] **Step 1: Replace free-text mail failures with typed results**

In `src/services/mailer.ts`, import mail types:

```ts
import type { MailExternalFailureCode } from '../lib/external-service-security'
```

Add result types near the top:

```ts
export type MailSendFailure = {
  ok: false
  code: MailExternalFailureCode
  message?: string
  status?: number
  retriable?: boolean
  accountIndex?: number
}

export type MailSendResult = { ok: true } | MailSendFailure
```

Change `sendWithAccount`:

```ts
async function sendWithAccount(
  account: ResendAccount,
  input: { toEmail: string; subject: string; html: string }
): Promise<{ ok: true } | { ok: false; status: number; retriable: boolean }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: account.from,
      to: [input.toEmail],
      subject: input.subject,
      html: input.html
    })
  })

  if (res.ok) return { ok: true }
  await res.text().catch(() => '')
  return {
    ok: false,
    status: res.status,
    retriable: isRetriableResendStatus(res.status)
  }
}
```

Change `sendResendEmail` signature and failure returns:

```ts
export async function sendResendEmail(
  env: { DB: D1Database },
  input: {
    toEmail: string
    subject: string
    html: string
    ignoreEnabledFlag?: boolean
  }
): Promise<MailSendResult> {
  const settings = await getSettings(env.DB)
  const accounts = settings.resend_accounts || []

  if (accounts.length === 0) {
    return { ok: false, code: 'MAIL_CONFIG_MISSING', message: '閭欢閰嶇疆鏆備笉鍙敤锛岃妫€鏌ュ悗鍙伴厤缃? }
  }
  if (!input.ignoreEnabledFlag && !settings.resend_enabled) {
    return { ok: false, code: 'MAIL_DISABLED', message: '閭欢閰嶇疆鏆備笉鍙敤锛岃妫€鏌ュ悗鍙伴厤缃? }
  }

  const toEmail = String(input.toEmail || '').trim()
  if (!toEmail || !toEmail.includes('@')) {
    return { ok: false, code: 'MAIL_INVALID_RECIPIENT', message: '璇疯緭鍏ユ湁鏁堢殑閭鍦板潃' }
  }

  let lastFailure: MailSendFailure | null = null
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]!
    try {
      const result = await sendWithAccount(account, {
        toEmail,
        subject: input.subject,
        html: input.html
      })
      if (result.ok) return { ok: true }
      lastFailure = {
        ok: false,
        code: 'RESEND_REQUEST_FAILED',
        message: '閭欢鍙戦€佸け璐?,
        status: result.status,
        retriable: result.retriable,
        accountIndex: i
      }
      if (i < accounts.length - 1) continue
    } catch {
      lastFailure = {
        ok: false,
        code: 'MAIL_NETWORK_FAILURE',
        message: '閭欢鍙戦€佸け璐?,
        retriable: true,
        accountIndex: i
      }
      if (i < accounts.length - 1) continue
    }
  }

  return lastFailure ?? {
    ok: false,
    code: 'MAIL_ALL_ACCOUNTS_FAILED',
    message: '閭欢鍙戦€佸け璐?,
    retriable: false
  }
}
```

Change `sendTestEmail` return type:

```ts
export async function sendTestEmail(
  env: { DB: D1Database },
  toEmail: string
): Promise<MailSendResult> {
```

Keep the email body meta line for the recipient inside the actual email; the spec only forbids echoing it in browser responses/logs.

- [ ] **Step 2: Map mail test route responses to fixed safe messages**

In `src/routes/admin.ts`, add imports:

```ts
import {
  MAIL_TEST_SUCCESS_MESSAGE,
  logMailExternalServiceFailure,
  safeMailTestClientMessage
} from '../lib/external-service-security'
```

Replace `/api/admin/mail/test` body:

```ts
app.post('/api/admin/mail/test', async (c) => {
  const denied = await requireJsonMutation(c)
  if (denied) return denied
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return apiErr(c, "鏃犳潈闄?, 403)

  const body = await readJsonBody(c)
  const toEmail = String(body.to_email ?? '').trim()
  if (!toEmail || !toEmail.includes('@')) {
    return apiErr(c, "璇疯緭鍏ユ湁鏁堢殑鎺ユ敹閭")
  }

  try {
    const result = await sendTestEmail(c.env, toEmail)
    if (!result.ok) {
      if (result.code !== 'MAIL_INVALID_RECIPIENT') {
        logMailExternalServiceFailure({
          code: result.code,
          stage: result.code === 'MAIL_CONFIG_MISSING' || result.code === 'MAIL_DISABLED' ? 'config' : 'send',
          status: result.status,
          accountIndex: result.accountIndex,
          retriable: result.retriable
        })
      }
      const status = result.code === 'MAIL_INVALID_RECIPIENT' ? 400 : 500
      return apiErr(c, safeMailTestClientMessage(result.code), status)
    }
    return apiOk(c, undefined, { message: MAIL_TEST_SUCCESS_MESSAGE })
  } catch {
    logMailExternalServiceFailure({ code: 'MAIL_NETWORK_FAILURE', stage: 'send', retriable: true })
    return apiErr(c, safeMailTestClientMessage('MAIL_NETWORK_FAILURE'), 500)
  }
})
```

- [ ] **Step 3: Run mail-focused regression tests**

Run:

```powershell
pnpm exec vitest run tests/external-service-redaction-routes.test.ts --reporter=dot
```

Expected: all tests in `tests/external-service-redaction-routes.test.ts` pass.

- [ ] **Step 4: Commit mail classification and response redaction**

```powershell
git add src/services/mailer.ts src/routes/admin.ts
git commit -m "fix: redact mail external service errors"
```

---

### Task 5: Final verification and privacy audit

**Files:**
- Read: `package.json`
- Read: `src/routes/dns.tsx`
- Read: `src/routes/admin.ts`
- Read: `src/services/cloudflare-dns.ts`
- Read: `src/services/mailer.ts`
- Read: `tests/external-service-redaction-routes.test.ts`

- [ ] **Step 1: Run the focused route test**

```powershell
pnpm exec vitest run tests/external-service-redaction-routes.test.ts --reporter=dot
```

Expected: all tests pass.

- [ ] **Step 2: Run related existing suites**

```powershell
pnpm exec vitest run tests/first-setup-routes.test.ts tests/oauth-registration-routes.test.ts tests/external-service-redaction-routes.test.ts --reporter=dot
```

Expected: all listed test files pass.

- [ ] **Step 3: Run the full test suite**

```powershell
pnpm test
```

Expected: all test files pass.

- [ ] **Step 4: Run TypeScript and whitespace checks**

```powershell
pnpm exec tsc --noEmit
git diff --check
```

Expected: both commands exit with code `0`.

- [ ] **Step 5: Verify Better Auth dependency lock**

```powershell
node -e "const p=require('./package.json'); console.log(p.dependencies['better-auth'],p.dependencies['@better-auth/passkey']); if(p.dependencies['better-auth']!=='1.6.23'||p.dependencies['@better-auth/passkey']!=='1.6.23') process.exit(1)"
```

Expected output:

```text
1.6.23 1.6.23
```

- [ ] **Step 6: Run privacy searches**

```powershell
rg -n "err instanceof Error \\? err\\.message|result\\.message \\|\\||Cloudflare API 璇锋眰澶辫触|Resend API 閿欒|CLOUDFLARE_API_TOKEN|DOMAINS" src/routes src/services
```

Expected:

- No route response path directly uses `err.message`.
- No route response path directly returns `result.message || ...` for mail test.
- No production response string exposes `CLOUDFLARE_API_TOKEN` or `DOMAINS`.
- No service error string contains `Cloudflare API 璇锋眰澶辫触` or `Resend API 閿欒`.

Also run:

```powershell
rg -n "sender-private@example\\.test|recipient-private@example\\.test|cf-secret-token|resend-secret-key|CF_PRIVATE_BODY|RESEND_PRIVATE_BODY" src tests/external-service-redaction-routes.test.ts
```

Expected: sensitive fixture strings appear only inside `tests/external-service-redaction-routes.test.ts`.

- [ ] **Step 7: Commit any verification-only test adjustments if needed**

If verification revealed small test expectation corrections, commit only those corrections:

```powershell
git add tests/external-service-redaction-routes.test.ts
git commit -m "test: stabilize external service redaction coverage"
```

Skip this commit when there are no changes.

- [ ] **Step 8: Report evidence**

Collect exact command outputs for:

- focused route test
- related suites
- full `pnpm test`
- `pnpm exec tsc --noEmit`
- `git diff --check`
- Better Auth version check
- privacy searches
- `git status --short`

Do not claim the鏁存敼椤?is complete unless the fresh outputs prove each acceptance criterion.

---

## Self-review checklist

- Spec coverage:
  - DNS create/update/delete failure response redaction is covered by Task 1 and Task 3.
  - Admin DNS delete paths are covered by Task 3 and final privacy searches.
  - DNS config-name redaction is covered by Task 1 and Task 3.
  - Mail failure response redaction is covered by Task 1 and Task 4.
  - Mail success no-recipient echo is covered by Task 1 and Task 4.
  - Allowlisted security logs are covered by Task 1, Task 2, Task 3, and Task 4.
  - Better Auth exact dependency lock is covered by Task 5.
- Type consistency:
  - DNS event codes and stages are defined once in `src/lib/external-service-security.ts`.
  - Mail result codes reuse `MailExternalFailureCode`.
  - Route helpers use `toDnsFailureEvent` so Cloudflare errors have one mapping path.
- Execution boundaries:
  - No implementation task changes `.dev.vars`.
  - No implementation task upgrades Better Auth packages.
  - No implementation task logs request bodies, cookies, IP, UA, email addresses, tokens, third-party response bodies, raw exceptions, or stacks.
