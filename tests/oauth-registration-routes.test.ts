import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import type { Bindings } from '../src/services/cloudflare-dns'
import {
  authorizeOAuthRegistrationIntent,
  bindOAuthRegistrationIntentState,
  createOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'
import {
  createTestD1,
  markFirstSetupCompleted,
  seedInvite,
  seedUser,
  type TestD1
} from './helpers/d1'
import {
  AUTH_ORIGIN,
  FIXTURE_PROVIDER_ID,
  sameOriginJsonHeaders,
  seedFixtureOAuthProvider,
  setRegistrationPolicy
} from './helpers/auth'

const instances: TestD1[] = []

async function setup(
  policy: { enabled: boolean; mode: 'email' | 'oauth' | 'both'; inviteRequired: boolean } = {
    enabled: true,
    mode: 'both',
    inviteRequired: false
  }
) {
  const instance = await createTestD1()
  instances.push(instance)
  await markFirstSetupCompleted(instance.db)
  await setRegistrationPolicy(instance.db, policy)
  await seedFixtureOAuthProvider(instance.db)
  const env: Bindings = {
    DB: instance.db,
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: AUTH_ORIGIN,
    APP_NAME: 'Test App'
  } as unknown as Bindings
  return { db: instance.db, env }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(instances.splice(0).map(({ dispose }) => dispose()))
})

async function request(
  env: Bindings,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return await app.request(`${AUTH_ORIGIN}${path}`, init, env)
}

async function postJson(env: Bindings, path: string, body: Record<string, unknown>) {
  return await request(env, path, {
    method: 'POST',
    headers: sameOriginJsonHeaders(),
    body: JSON.stringify(body)
  })
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function intentRows(db: D1Database) {
  return (await db.prepare(
    `SELECT id, token_hash, provider_id, oauth_state_hash, invite_code_id,
            authorized_at, authorized_user_id, consumed_at
     FROM oauth_registration_intent ORDER BY created_at ASC`
  ).all<Record<string, unknown>>()).results ?? []
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function allSetCookies(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof enhanced.getSetCookie === 'function') return enhanced.getSetCookie()
  const combined = headers.get('set-cookie')
  return combined ? [combined] : []
}

describe('OAuth registration routes', { timeout: 15_000 }, () => {
  it('blocks the public generic OAuth sign-in endpoint', async () => {
    const { env } = await setup()
    const response = await postJson(env, '/api/auth/sign-in/oauth2', {
      providerId: FIXTURE_PROVIDER_ID,
      requestSignUp: true
    })

    expect(response.status).toBe(403)
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      code: 'OAUTH2_PUBLIC_ENTRY_DISABLED'
    })
  })

  it('keeps custom OAuth login available without creating a registration intent', async () => {
    const { db, env } = await setup()
    const response = await postJson(env, '/api/auth/oauth/login', {
      provider_id: FIXTURE_PROVIDER_ID
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true })
    expect(new URL(String(body.redirect)).origin).toBe('https://provider.example')
    expect(await intentRows(db)).toHaveLength(0)
  })

  it.each([
    { enabled: false, mode: 'both' as const, expectedStatus: 403 },
    { enabled: true, mode: 'email' as const, expectedStatus: 403 }
  ])('rejects disabled OAuth registration before intent creation: $mode', async (policy) => {
    const { db, env } = await setup({
      enabled: policy.enabled,
      mode: policy.mode,
      inviteRequired: false
    })
    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID
    })

    expect(response.status).toBe(policy.expectedStatus)
    expect(await intentRows(db)).toHaveLength(0)
  })

  it.each([
    { label: 'missing', providerId: '' },
    { label: 'unknown', providerId: 'unknown-provider' }
  ])('returns a stable failure for a $label Provider without retaining an intent', async ({ providerId }) => {
    const { db, env } = await setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: providerId
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      code: 'OAUTH_REGISTRATION_FAILED',
      message: 'OAuth 注册失败，请重新发起注册'
    })
    expect(await intentRows(db)).toHaveLength(0)
    if (providerId) {
      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain(providerId)
    }
  })

  it('returns a stable failure for a disabled Provider without retaining an intent', async () => {
    const { db, env } = await setup()
    await db.prepare("UPDATE oauth_provider SET enabled = 0 WHERE provider_id = ?")
      .bind(FIXTURE_PROVIDER_ID)
      .run()

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({ code: 'OAUTH_REGISTRATION_FAILED' })
    expect(await intentRows(db)).toHaveLength(0)
  })

  it.each([
    { label: 'missing', code: '', setupInvite: 'none' },
    { label: 'unknown', code: 'NO-SUCH-INVITE', setupInvite: 'none' },
    { label: 'used', code: 'USED-INVITE', setupInvite: 'used' },
    { label: 'revoked', code: 'REVOKED-INVITE', setupInvite: 'revoked' }
  ])('returns the same stable failure for a $label required invite', async ({ code, setupInvite }) => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    if (setupInvite === 'used') {
      await seedInvite(db, adminId, { code, usedBy: adminId })
    } else if (setupInvite === 'revoked') {
      await seedInvite(db, adminId, { code, revoked: 1 })
    }

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID,
      invite_code: code
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      code: 'OAUTH_REGISTRATION_FAILED',
      message: 'OAuth 注册失败，请重新发起注册'
    })
    expect(await intentRows(db)).toHaveLength(0)
  })

  it('does not create a second intent when a required invite is already reserved', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const invite = await seedInvite(db, adminId, { code: 'RESERVED-INVITE' })
    const existing = await createOAuthRegistrationIntent(db, {
      providerId: FIXTURE_PROVIDER_ID,
      inviteRequired: true,
      inviteCode: invite.code
    })

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID,
      invite_code: invite.code
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({ code: 'OAUTH_REGISTRATION_FAILED' })
    expect(await intentRows(db)).toHaveLength(1)
    expect(await db.prepare('SELECT reserved_intent_id FROM invite_code WHERE id = ?')
      .bind(invite.id)
      .first<{ reserved_intent_id: string | null }>()).toEqual({ reserved_intent_id: existing.id })
  })

  it('creates and binds a hashed intent before exposing its secure cookie', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const invite = await seedInvite(db, adminId, { code: 'SECRET-INVITE' })

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID,
      invite_code: invite.code
    })
    const rawBody = await response.clone().text()
    const body = JSON.parse(rawBody) as Record<string, unknown>
    const authorization = new URL(String(body.redirect))
    const state = authorization.searchParams.get('state') ?? ''
    const cookies = allSetCookies(response.headers)
    const intentCookie = cookies.find((value) => value.startsWith('oauth_registration_intent=')) ?? ''
    const clearToken = decodeURIComponent(intentCookie.split(';', 1)[0]!.split('=', 2)[1] ?? '')
    const rows = await intentRows(db)

    expect(response.status).toBe(200)
    expect(state).not.toBe('')
    expect(intentCookie).toContain('HttpOnly')
    expect(intentCookie).toContain('SameSite=Lax')
    expect(intentCookie).toContain('Secure')
    expect(intentCookie).toContain('Max-Age=600')
    expect(cookies.join('\n')).not.toContain('pending_invite_code')
    expect(response.headers.toString()).not.toContain(invite.code)
    expect(rawBody).not.toContain(invite.code)
    expect(authorization.toString()).not.toContain(invite.code)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider_id: FIXTURE_PROVIDER_ID,
      oauth_state_hash: await sha256Hex(state),
      invite_code_id: invite.id,
      authorized_at: null,
      consumed_at: null
    })
    expect(rows[0]!.token_hash).toBe(await sha256Hex(clearToken))
    expect(JSON.stringify(rows[0])).not.toContain(clearToken)
    expect(JSON.stringify(rows[0])).not.toContain(invite.code)
  })

  it('releases the pending intent and invite reservation when OAuth URL generation fails', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const invite = await seedInvite(db, adminId, { code: 'URL-FAIL-INVITE' })
    await db.prepare(
      "UPDATE oauth_provider SET authorization_url = 'not-a-valid-url' WHERE provider_id = ?"
    ).bind(FIXTURE_PROVIDER_ID).run()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID,
      invite_code: invite.code
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({ code: 'OAUTH_REGISTRATION_FAILED' })
    expect(await intentRows(db)).toHaveLength(0)
    expect(await db.prepare('SELECT reserved_intent_id, used_by FROM invite_code WHERE id = ?')
      .bind(invite.id)
      .first()).toEqual({ reserved_intent_id: null, used_by: null })
    const logs = errorSpy.mock.calls.flat().join('\n')
    expect(logs).not.toContain(invite.code)
    expect(logs).not.toContain('not-a-valid-url')
  })

  it('releases the pending intent and invite reservation when state binding fails', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const invite = await seedInvite(db, adminId, { code: 'BIND-FAIL-INVITE' })
    await db.prepare(
      `CREATE TRIGGER force_oauth_state_bind_failure
       BEFORE UPDATE OF oauth_state_hash ON oauth_registration_intent
       BEGIN
         SELECT RAISE(ABORT, 'forced_state_bind_failure');
       END`
    ).run()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await postJson(env, '/api/auth/oauth/register', {
      provider_id: FIXTURE_PROVIDER_ID,
      invite_code: invite.code
    })

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({ code: 'OAUTH_REGISTRATION_FAILED' })
    expect(await intentRows(db)).toHaveLength(0)
    expect(await db.prepare('SELECT reserved_intent_id, used_by FROM invite_code WHERE id = ?')
      .bind(invite.id)
      .first()).toEqual({ reserved_intent_id: null, used_by: null })
    const logs = errorSpy.mock.calls.flat().join('\n')
    expect(logs).not.toContain(invite.code)
    expect(logs).not.toContain('forced_state_bind_failure')
  })

  it('completion only releases pending state, clears the intent cookie, and does not consume the invite', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const invite = await seedInvite(db, adminId, { code: 'DONE-INVITE' })
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: FIXTURE_PROVIDER_ID,
      inviteRequired: true,
      inviteCode: invite.code
    })

    const response = await request(env, '/register/oauth/done', {
      headers: { cookie: `oauth_registration_intent=${intent.token}` },
      redirect: 'manual'
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/login?error=')
    expect(allSetCookies(response.headers).join('\n')).toContain('oauth_registration_intent=')
    expect(allSetCookies(response.headers).join('\n')).toContain('Max-Age=0')
    expect(await intentRows(db)).toHaveLength(0)
    expect(await db.prepare('SELECT reserved_intent_id, used_by, used_at FROM invite_code WHERE id = ?')
      .bind(invite.id)
      .first()).toEqual({ reserved_intent_id: null, used_by: null, used_at: null })
  })

  it('error callback ignores Provider details and releases only pending state', async () => {
    const { db, env } = await setup()
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: FIXTURE_PROVIDER_ID,
      inviteRequired: false,
      inviteCode: ''
    })

    const response = await request(
      env,
      '/register/oauth/error?error=provider-secret&error_description=sensitive-description&code=secret-code',
      {
        headers: { cookie: `oauth_registration_intent=${intent.token}` },
        redirect: 'manual'
      }
    )
    const location = response.headers.get('location') ?? ''

    expect(response.status).toBe(302)
    expect(location).toBe(
      '/register?error=' +
      encodeURIComponent('OAuth 注册失败，请重新发起注册') +
      '&code=OAUTH_REGISTRATION_FAILED'
    )
    expect(location).not.toContain('provider-secret')
    expect(location).not.toContain('sensitive-description')
    expect(location).not.toContain('secret-code')
    expect(allSetCookies(response.headers).join('\n')).toContain('Max-Age=0')
    expect(await intentRows(db)).toHaveLength(0)
  })

  it('does not release an authorized intent with no user during its quarantine period', async () => {
    const { db, env } = await setup()
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: FIXTURE_PROVIDER_ID,
      inviteRequired: false,
      inviteCode: ''
    })
    await bindOAuthRegistrationIntentState(db, {
      id: intent.id,
      token: intent.token,
      providerId: FIXTURE_PROVIDER_ID,
      state: 'authorized-state'
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: FIXTURE_PROVIDER_ID,
      state: 'authorized-state',
      userId: 'not-in-user-table'
    })

    const response = await request(env, '/register/oauth/error', {
      headers: { cookie: `oauth_registration_intent=${intent.token}` },
      redirect: 'manual'
    })

    expect(response.status).toBe(302)
    expect(await intentRows(db)).toHaveLength(1)
    expect((await intentRows(db))[0]).toMatchObject({
      id: intent.id,
      authorized_user_id: 'not-in-user-table',
      consumed_at: null
    })
  })

  it('preserves the stable GitHub account-age rejection redirect', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: false })
    await db.prepare(
      "UPDATE oauth_provider SET provider_id = 'github' WHERE provider_id = ?"
    ).bind(FIXTURE_PROVIDER_ID).run()
    await db.prepare(
      "UPDATE settings SET github_min_account_age_days = 30 WHERE id = 'default'"
    ).run()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'https://provider.example/token') {
        return Response.json({ access_token: 'github-access-token', token_type: 'Bearer' })
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 12345,
          login: 'young-account',
          name: 'Young Account',
          email: 'young-github@example.test',
          avatar_url: null,
          created_at: new Date(Date.now() - 2 * 86400000).toISOString()
        })
      }
      return new Response('not found', { status: 404 })
    })

    const started = await postJson(env, '/api/auth/oauth/register', {
      provider_id: 'github'
    })
    const startBody = await jsonBody(started)
    const authorization = new URL(String(startBody.redirect))
    const state = authorization.searchParams.get('state') ?? ''
    const cookie = allSetCookies(started.headers)
      .map((value) => value.split(';', 1)[0])
      .join('; ')

    const callbackResponse = await request(
      env,
      `/api/auth/oauth2/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie }, redirect: 'manual' }
    )
    const location = callbackResponse.headers.get('location') ?? ''

    expect(callbackResponse.status).toBe(302)
    expect(location).toMatch(/^\/register\/github-age-rejected\?min_days=30(?:&actual_days=\d+)?$/)
    expect(await db.prepare('SELECT COUNT(*) AS count FROM user').first<{ count: number }>())
      .toEqual({ count: 0 })
    expect(await db.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>())
      .toEqual({ count: 0 })
  })

  it('uses shared cleanup to reconcile an authorized intent whose user exists', async () => {
    const { db, env } = await setup({ enabled: true, mode: 'oauth', inviteRequired: true })
    const adminId = await seedUser(db)
    const userId = await seedUser(db, { id: '9002', email: 'oauth-route@example.test' })
    const invite = await seedInvite(db, adminId, { code: 'RECONCILE-INVITE' })
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: FIXTURE_PROVIDER_ID,
      inviteRequired: true,
      inviteCode: invite.code
    })
    await bindOAuthRegistrationIntentState(db, {
      id: intent.id,
      token: intent.token,
      providerId: FIXTURE_PROVIDER_ID,
      state: 'reconcile-state'
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: FIXTURE_PROVIDER_ID,
      state: 'reconcile-state',
      userId
    })

    const response = await request(env, '/register/oauth/done', {
      headers: { cookie: `oauth_registration_intent=${intent.token}` },
      redirect: 'manual'
    })

    expect(response.status).toBe(302)
    expect((await intentRows(db))[0]).toMatchObject({
      id: intent.id,
      authorized_user_id: userId,
      consumed_at: expect.any(Number)
    })
    expect(await db.prepare('SELECT reserved_intent_id, used_by FROM invite_code WHERE id = ?')
      .bind(invite.id)
      .first()).toEqual({ reserved_intent_id: null, used_by: userId })
  })
})
