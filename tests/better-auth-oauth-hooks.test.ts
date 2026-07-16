import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuth, type AuthBindings } from '../src/auth'
import {
  bindOAuthRegistrationIntentState,
  createOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'
import {
  createTestD1,
  disposeTestD1Instances,
  markFirstSetupCompleted,
  seedInvite,
  seedUser,
  type TestD1
} from './helpers/d1'
import {
  AUTH_ORIGIN,
  cookiesFromHeaders,
  mergeCookieHeaders,
  mockOAuthProviderFetch,
  sameOriginJsonHeaders,
  seedFixtureOAuthProvider,
  setRegistrationPolicy
} from './helpers/auth'

const instances: TestD1[] = []
type TestAuth = Awaited<ReturnType<typeof createAuth>>

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
  const env: AuthBindings = {
    DB: instance.db,
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: AUTH_ORIGIN,
    APP_NAME: 'Test App'
  }
  return { db: instance.db, env, auth: await createAuth(env) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeTestD1Instances(instances)
})

async function startOAuth(auth: TestAuth, requestSignUp: boolean) {
  const response = await auth.api.signInWithOAuth2({
    headers: sameOriginJsonHeaders(),
    body: {
      providerId: 'fixture',
      callbackURL: '/done',
      errorCallbackURL: '/error',
      disableRedirect: true,
      requestSignUp
    },
    asResponse: true
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { url: string }
  const url = new URL(body.url)
  return {
    state: url.searchParams.get('state') ?? '',
    cookies: cookiesFromHeaders(response.headers)
  }
}

async function callback(auth: TestAuth, state: string, cookies: string) {
  return await auth.handler(new Request(
    `${AUTH_ORIGIN}/api/auth/oauth2/callback/fixture?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookies } }
  ))
}

async function createBoundIntent(
  db: D1Database,
  input: {
    state: string
    providerId?: string
    inviteRequired?: boolean
    inviteCode?: string
    now?: number
  }
) {
  const providerId = input.providerId ?? 'fixture'
  const intent = await createOAuthRegistrationIntent(db, {
    providerId,
    inviteRequired: input.inviteRequired ?? false,
    inviteCode: input.inviteCode ?? '',
    now: input.now
  })
  await bindOAuthRegistrationIntentState(db, {
    id: intent.id,
    token: intent.token,
    providerId,
    state: input.state,
    now: input.now
  })
  return intent
}

async function completeRegistration(
  auth: TestAuth,
  db: D1Database,
  input: { inviteRequired?: boolean; inviteCode?: string } = {}
) {
  const started = await startOAuth(auth, true)
  const intent = await createBoundIntent(db, {
    state: started.state,
    inviteRequired: input.inviteRequired,
    inviteCode: input.inviteCode
  })
  const response = await callback(
    auth,
    started.state,
    mergeCookieHeaders(
      started.cookies,
      `oauth_registration_intent=${intent.token}`
    )
  )
  return { response, intent }
}

async function rowCount(db: D1Database, table: 'user' | 'account' | 'session'): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

describe('Better Auth OAuth registration hooks', { timeout: 30_000 }, () => {
  it('keeps email signup numeric without requiring an OAuth intent', async () => {
    const { auth } = await setup()
    const result = await auth.api.signUpEmail({
      body: {
        name: 'Email User',
        email: 'email-user@example.test',
        password: 'password123'
      }
    })
    expect(result.user.id).toBe('1')
  })

  it('rejects a generic callback that creates a user without an intent cookie', async () => {
    const { auth, db } = await setup()
    mockOAuthProviderFetch()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const started = await startOAuth(auth, true)

    await callback(auth, started.state, started.cookies)

    expect(await rowCount(db, 'user')).toBe(0)
    expect(await rowCount(db, 'session')).toBe(0)
  })

  it.each([
    'wrong-token',
    'wrong-provider',
    'wrong-state',
    'expired'
  ] as const)('rejects %s before inserting a user', async (failure) => {
    const { auth, db } = await setup()
    mockOAuthProviderFetch()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const started = await startOAuth(auth, true)
    const providerId = failure === 'wrong-provider' ? 'other-provider' : 'fixture'
    const state = failure === 'wrong-state' ? 'different-intent-state' : started.state
    const now = failure === 'expired' ? 1 : undefined
    const intent = await createBoundIntent(db, { providerId, state, now })
    const cookieToken = failure === 'wrong-token' ? 'wrong-intent-token' : intent.token

    await callback(
      auth,
      started.state,
      mergeCookieHeaders(started.cookies, `oauth_registration_intent=${cookieToken}`)
    )

    expect(await rowCount(db, 'user')).toBe(0)
    expect(await rowCount(db, 'session')).toBe(0)
  })

  it('creates user and account, consumes the invite, and signs in only for a valid intent', async () => {
    const { auth, db } = await setup({
      enabled: true,
      mode: 'both',
      inviteRequired: true
    })
    mockOAuthProviderFetch()
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    await db.prepare(
      `CREATE TRIGGER assert_oauth_intent_consumed_before_session
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
       END`
    ).run()

    const { response, intent } = await completeRegistration(auth, db, {
      inviteRequired: true,
      inviteCode: invite.code
    })

    expect(response.status).toBe(302)
    expect(cookiesFromHeaders(response.headers)).toMatch(/session_token=/)
    const oauthUser = await db.prepare(
      'SELECT id FROM user WHERE email = ?'
    ).bind('oauth-user@example.test').first<{ id: string }>()
    expect(oauthUser?.id).toMatch(/^\d+$/)
    expect(await rowCount(db, 'account')).toBe(1)
    expect(await rowCount(db, 'session')).toBe(1)
    const intentRow = await db.prepare(
      'SELECT consumed_at FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first<{ consumed_at: number | null }>()
    expect(intentRow?.consumed_at).not.toBeNull()
    const inviteRow = await db.prepare(
      'SELECT used_by, reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{
      used_by: string | null
      reserved_intent_id: string | null
    }>()
    expect(inviteRow).toEqual({ used_by: oauthUser?.id, reserved_intent_id: null })
  })

  it('allows an existing OAuth user to sign in without an intent', async () => {
    const { auth, db } = await setup()
    mockOAuthProviderFetch()
    const first = await completeRegistration(auth, db)
    expect(first.response.status).toBe(302)

    const started = await startOAuth(auth, false)
    const second = await callback(auth, started.state, started.cookies)

    expect(second.status).toBe(302)
    expect(await rowCount(db, 'user')).toBe(1)
    expect(await rowCount(db, 'account')).toBe(1)
    expect(await rowCount(db, 'session')).toBe(2)
  })

  it('allows auth.api.oAuth2LinkAccount callbacks without a registration intent', async () => {
    const { auth, db } = await setup()
    mockOAuthProviderFetch()
    const signup = await auth.api.signUpEmail({
      body: {
        name: 'Link User',
        email: 'link-user@example.test',
        password: 'password123'
      }
    })
    const signIn = await auth.api.signInEmail({
      headers: sameOriginJsonHeaders(),
      body: {
        email: 'link-user@example.test',
        password: 'password123'
      },
      asResponse: true
    })
    const sessionCookies = cookiesFromHeaders(signIn.headers)
    const linkResponse = await auth.api.oAuth2LinkAccount({
      headers: new Headers({ cookie: sessionCookies }),
      body: {
        providerId: 'fixture',
        callbackURL: '/linked',
        errorCallbackURL: '/link-error'
      },
      asResponse: true
    })
    expect(linkResponse.status).toBe(200)
    const linkBody = await linkResponse.json() as { url: string }
    const linkUrl = new URL(linkBody.url)
    const state = linkUrl.searchParams.get('state') ?? ''
    const response = await callback(
      auth,
      state,
      mergeCookieHeaders(sessionCookies, cookiesFromHeaders(linkResponse.headers))
    )

    expect(response.status).toBe(302)
    expect(await rowCount(db, 'user')).toBe(1)
    const account = await db.prepare(
      'SELECT userId FROM account WHERE providerId = ? AND accountId = ?'
    ).bind('fixture', 'provider-user-1').first<{ userId: string }>()
    expect(account?.userId).toBe(signup.user.id)
  })

  it('keeps the invite consumed when Better Auth 1.6.23 fails account insertion after user hooks', async () => {
    const { auth, db } = await setup({
      enabled: true,
      mode: 'oauth',
      inviteRequired: true
    })
    mockOAuthProviderFetch()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    await db.prepare(
      `CREATE TRIGGER force_account_failure
       BEFORE INSERT ON account
       BEGIN
         SELECT RAISE(ABORT, 'forced_account_failure');
       END`
    ).run()

    await completeRegistration(auth, db, {
      inviteRequired: true,
      inviteCode: invite.code
    })

    const users = await db.prepare(
      'SELECT id FROM user WHERE email = ?'
    ).bind('oauth-user@example.test').all<{ id: string }>()
    expect(users.results).toHaveLength(1)
    expect(users.results[0]?.id).toMatch(/^\d+$/)
    expect(await rowCount(db, 'session')).toBe(0)
    const inviteRow = await db.prepare(
      'SELECT used_by, reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{
      used_by: string | null
      reserved_intent_id: string | null
    }>()
    expect(inviteRow).toEqual({
      used_by: users.results[0]?.id,
      reserved_intent_id: null
    })
  })

  it('prevents session creation when intent finalization fails', async () => {
    const { auth, db } = await setup()
    mockOAuthProviderFetch()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await db.prepare(
      `CREATE TRIGGER force_intent_finalization_failure
       BEFORE UPDATE OF consumed_at ON oauth_registration_intent
       WHEN NEW.consumed_at IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 'forced_finalization_failure');
       END`
    ).run()

    const { intent } = await completeRegistration(auth, db)

    expect(await rowCount(db, 'session')).toBe(0)
    const row = await db.prepare(
      'SELECT authorized_at, consumed_at FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first<{
      authorized_at: number | null
      consumed_at: number | null
    }>()
    expect(row?.authorized_at).not.toBeNull()
    expect(row?.consumed_at).toBeNull()
  })
})
