import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from 'better-auth/crypto'
import app from '../src/index'
import { createAuth } from '../src/auth'
import type { Bindings } from '../src/services/cloudflare-dns'
import { updateSettings } from '../src/services/settings'
import {
  bindFirstSetupUser,
  claimFirstSetup,
  getFirstSetupState
} from '../src/services/first-setup'
import {
  bindOAuthRegistrationIntentState,
  createOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'
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
  FIXTURE_PROVIDER_ID,
  mergeCookieHeaders,
  mockOAuthProviderFetch,
  sameOriginJsonHeaders,
  seedFixtureOAuthProvider
} from './helpers/auth'

const instances: TestD1[] = []

const validSetupBody = {
  name: 'Setup Admin',
  email: 'setup-admin@example.test',
  password: 'password123',
  confirm: 'password123'
}

async function setupOpen() {
  const instance = await createTestD1()
  instances.push(instance)
  const env: Bindings = {
    DB: instance.db,
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: AUTH_ORIGIN,
    APP_NAME: 'Test App'
  } as unknown as Bindings
  return { db: instance.db, env }
}

async function postSetup(
  env: Bindings,
  body: Record<string, unknown> = validSetupBody,
  headers: Headers = sameOriginJsonHeaders()
): Promise<Response> {
  return await app.request(`${AUTH_ORIGIN}/api/auth/setup`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, env)
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function postJson(
  env: Bindings,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await app.request(`${AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: sameOriginJsonHeaders(),
    body: JSON.stringify(body)
  }, env)
}

async function getPage(env: Bindings, path: string): Promise<Response> {
  return await app.request(`${AUTH_ORIGIN}${path}`, undefined, env)
}

type PageSetupStatus = 'open' | 'claimed' | 'claimed-orphan' | 'completed'

async function setupPageState(status: PageSetupStatus) {
  const fixture = await setupOpen()
  if (status === 'claimed' || status === 'claimed-orphan') {
    const claim = await claimFirstSetup(fixture.db)
    if (status === 'claimed-orphan') {
      const userId = 'orphan-admin'
      await bindFirstSetupUser(fixture.db, { token: claim.token, userId })
      await seedUser(fixture.db, {
        id: userId,
        email: 'orphan-admin@example.test'
      })
    }
  } else if (status === 'completed') {
    await seedUser(fixture.db)
    await markFirstSetupCompleted(fixture.db)
  }
  return fixture
}

async function registrationSideEffects(db: D1Database) {
  const [verifications, users, accounts, counter] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM email_verification').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM account').first<{ n: number }>(),
    db.prepare("SELECT value FROM user_id_counter WHERE name = 'user'").first<{ value: number }>()
  ])
  return {
    verifications: Number(verifications?.n ?? 0),
    users: Number(users?.n ?? 0),
    accounts: Number(accounts?.n ?? 0),
    nextId: Number(counter?.value ?? 0)
  }
}

async function counts(db: D1Database) {
  const [users, credentials] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>(),
    db.prepare(
      "SELECT COUNT(*) AS n FROM account WHERE providerId = 'credential'"
    ).first<{ n: number }>()
  ])
  return {
    users: Number(users?.n ?? 0),
    credentials: Number(credentials?.n ?? 0)
  }
}

async function enableRaceRegistration(db: D1Database): Promise<void> {
  await updateSettings(db, {
    registration_enabled: true,
    registration_mode: 'both',
    invite_required: false,
    resend_enabled: false,
    resend_accounts: []
  })
}

async function expectOnlySetupAdministrator(db: D1Database): Promise<string> {
  const users = await db.prepare(
    'SELECT id, email, role, super_admin FROM user ORDER BY id'
  ).all<{
    id: string
    email: string
    role: string
    super_admin: number
  }>()
  expect(users.results).toHaveLength(1)
  expect(users.results[0]).toMatchObject({
    email: validSetupBody.email,
    role: 'admin',
    super_admin: 1
  })

  const accounts = await db.prepare(
    'SELECT providerId, userId FROM account ORDER BY providerId, userId'
  ).all<{ providerId: string; userId: string }>()
  expect(accounts.results).toEqual([{
    providerId: 'credential',
    userId: users.results[0]!.id
  }])
  expect(await getFirstSetupState(db)).toMatchObject({
    status: 'completed',
    claimedUserId: users.results[0]!.id
  })
  return users.results[0]!.id
}

async function prepareOAuthRegistrationCallback(db: D1Database, env: Bindings) {
  await seedFixtureOAuthProvider(db)
  const auth = await createAuth(env)
  const started = await auth.api.signInWithOAuth2({
    headers: sameOriginJsonHeaders(),
    body: {
      providerId: FIXTURE_PROVIDER_ID,
      callbackURL: '/register/oauth/done',
      errorCallbackURL: '/register/oauth/error',
      disableRedirect: true,
      requestSignUp: true
    },
    asResponse: true
  })
  expect(started.status).toBe(200)
  const startedBody = await started.json() as { url: string }
  const state = new URL(startedBody.url).searchParams.get('state') ?? ''
  expect(state).not.toBe('')

  const intent = await createOAuthRegistrationIntent(db, {
    providerId: FIXTURE_PROVIDER_ID,
    inviteRequired: false,
    inviteCode: ''
  })
  await bindOAuthRegistrationIntentState(db, {
    id: intent.id,
    token: intent.token,
    providerId: FIXTURE_PROVIDER_ID,
    state
  })
  const cookies = mergeCookieHeaders(
    cookiesFromHeaders(started.headers),
    `oauth_registration_intent=${intent.token}`
  )
  const callbackUrl =
    `${AUTH_ORIGIN}/api/auth/oauth2/callback/${FIXTURE_PROVIDER_ID}` +
    `?code=test-code&state=${encodeURIComponent(state)}`

  return {
    intentId: intent.id,
    request: () => app.request(callbackUrl, {
      headers: { cookie: cookies }
    }, env)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeTestD1Instances(instances)
})

describe('first setup route', { timeout: 30_000 }, () => {
  it.each([
    ['missing fields', { name: '', email: '', password: '', confirm: '' }],
    ['mismatched passwords', { ...validSetupBody, confirm: 'different-password' }],
    ['short password', { ...validSetupBody, password: 'short', confirm: 'short' }]
  ])('does not claim setup for %s', async (_label, body) => {
    const { db, env } = await setupOpen()
    const response = await postSetup(env, body)

    expect(response.status).toBe(400)
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'open' })
    expect(await counts(db)).toEqual({ users: 0, credentials: 0 })
  })

  it('creates exactly one credential super administrator and completes setup', async () => {
    const { db, env } = await setupOpen()
    const response = await postSetup(env)
    const body = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true })
    expect(['/','/login']).toContain(body.redirect)
    expect(await counts(db)).toEqual({ users: 1, credentials: 1 })
    expect(await db.prepare(
      'SELECT id, role, super_admin FROM user'
    ).first()).toEqual({ id: '1', role: 'admin', super_admin: 1 })
    expect(await getFirstSetupState(db)).toMatchObject({
      status: 'completed',
      claimedUserId: '1'
    })
  })

  it('allows at most one winner across five concurrent setup rounds', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { db, env } = await setupOpen()
      const [first, second] = await Promise.all([
        postSetup(env, {
          ...validSetupBody,
          email: `setup-a-${round}@example.test`
        }),
        postSetup(env, {
          ...validSetupBody,
          email: `setup-b-${round}@example.test`
        })
      ])
      const bodies = await Promise.all([jsonBody(first), jsonBody(second)])
      const winners = bodies.filter((body) => body.success === true)
      const loser = bodies.find((body) => body.success === false)

      expect(winners).toHaveLength(1)
      expect(['SETUP_IN_PROGRESS', 'SETUP_DONE']).toContain(loser?.code)
      expect(await counts(db)).toEqual({ users: 1, credentials: 1 })
      expect(await db.prepare(
        'SELECT role, super_admin FROM user'
      ).first()).toEqual({ role: 'admin', super_admin: 1 })
      expect(await getFirstSetupState(db)).toMatchObject({ status: 'completed' })
    }
  })

  it('keeps ordinary email registration from winning five setup races', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { db, env } = await setupOpen()
      await enableRaceRegistration(db)

      const [setupResponse, registrationResponse] = await Promise.all([
        postSetup(env),
        postJson(env, '/api/auth/register', {
          name: `Race Email ${round}`,
          email: `race-email-${round}@example.test`,
          password: 'password123',
          invite_code: ''
        })
      ])

      expect(setupResponse.status).toBe(200)
      expect(registrationResponse.status).toBe(409)
      expect(await jsonBody(registrationResponse)).toMatchObject({
        success: false,
        code: 'SETUP_NOT_READY'
      })
      await expectOnlySetupAdministrator(db)
    }
  })

  it('keeps a prepared OAuth callback from winning five setup races', { timeout: 90_000 }, async () => {
    for (let round = 0; round < 5; round += 1) {
      const { db, env } = await setupOpen()
      await enableRaceRegistration(db)
      const callback = await prepareOAuthRegistrationCallback(db, env)
      mockOAuthProviderFetch()

      const [setupResponse, callbackResponse] = await Promise.all([
        postSetup(env),
        callback.request()
      ])

      expect(setupResponse.status).toBe(200)
      expect(callbackResponse.status).toBe(302)
      const setupUserId = await expectOnlySetupAdministrator(db)

      const intent = await db.prepare(
        `SELECT authorized_at, authorized_user_id, consumed_at
         FROM oauth_registration_intent WHERE id = ?`
      ).bind(callback.intentId).first<{
        authorized_at: number | null
        authorized_user_id: string | null
        consumed_at: number | null
      }>()
      expect(intent).toEqual({
        authorized_at: null,
        authorized_user_id: null,
        consumed_at: null
      })
      const sessions = await db.prepare(
        'SELECT userId FROM session ORDER BY userId'
      ).all<{ userId: string }>()
      expect(sessions.results.every((row) => row.userId === setupUserId)).toBe(true)
      vi.restoreAllMocks()
    }
  })

  it('returns SETUP_DONE for completed setup without exposing user data', async () => {
    const { db, env } = await setupOpen()
    await markFirstSetupCompleted(db)
    const response = await postSetup(env)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(text)).toMatchObject({ success: false, code: 'SETUP_DONE' })
    expect(text).not.toContain(validSetupBody.email)
    expect(text).not.toContain(validSetupBody.name)
  })

  it('returns SETUP_IN_PROGRESS without changing an active claim hash', async () => {
    const { db, env } = await setupOpen()
    await claimFirstSetup(db)
    const before = await db.prepare(
      'SELECT claim_token_hash FROM first_setup WHERE id = 1'
    ).first<{ claim_token_hash: string }>()

    const response = await postSetup(env)
    const body = await jsonBody(response)
    const after = await db.prepare(
      'SELECT claim_token_hash FROM first_setup WHERE id = 1'
    ).first<{ claim_token_hash: string }>()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({ success: false, code: 'SETUP_IN_PROGRESS' })
    expect(after).toEqual(before)
    expect(await counts(db)).toEqual({ users: 0, credentials: 0 })
  })

  it('releases the claim immediately when user creation fails before insert', async () => {
    const { db, env } = await setupOpen()
    await db.prepare(
      `CREATE TRIGGER fail_setup_id_allocation
       BEFORE UPDATE ON user_id_counter
       BEGIN
         SELECT RAISE(ABORT, 'forced_setup_id_failure');
       END`
    ).run()

    const response = await postSetup(env)

    expect(response.status).toBe(500)
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      code: 'SETUP_FAILED'
    })
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'open' })
    expect(await counts(db)).toEqual({ users: 0, credentials: 0 })
  })

  it('deletes an orphan user and reopens setup when credential insertion fails', async () => {
    const { db, env } = await setupOpen()
    await db.prepare(
      `CREATE TRIGGER fail_setup_credential
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'credential'
       BEGIN
         SELECT RAISE(ABORT, 'forced_setup_credential_failure');
       END`
    ).run()

    const response = await postSetup(env)

    expect(response.status).toBe(500)
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      code: 'SETUP_FAILED'
    })
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'open' })
    expect(await counts(db)).toEqual({ users: 0, credentials: 0 })
  })

  it('keeps the completed administrator when only automatic sign-in fails', async () => {
    const { db, env } = await setupOpen()
    await db.prepare(
      `CREATE TRIGGER fail_setup_session
       BEFORE INSERT ON session
       BEGIN
         SELECT RAISE(ABORT, 'forced_setup_session_failure');
       END`
    ).run()

    const response = await postSetup(env)
    const body = await jsonBody(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, redirect: '/login' })
    expect(await counts(db)).toEqual({ users: 1, credentials: 1 })
    expect(await db.prepare(
      'SELECT role, super_admin FROM user'
    ).first()).toEqual({ role: 'admin', super_admin: 1 })
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'completed' })
  })


  it.each(['open', 'claimed'] as const)(
    'blocks email registration before side effects while setup is %s',
    async (status) => {
      const { db, env } = await setupOpen()
      await updateSettings(db, {
        registration_enabled: true,
        registration_mode: 'email',
        invite_required: false,
        resend_enabled: true,
        resend_accounts: [{ api_key: 'private-resend-key', from: 'sender@example.test' }]
      })
      if (status === 'claimed') await claimFirstSetup(db)
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('mailer must not be called before setup')
      })

      const response = await postJson(env, '/api/auth/register', {
        name: 'Blocked Registration',
        email: 'blocked-registration@example.test',
        password: 'password123',
        invite_code: ''
      })

      expect(response.status).toBe(409)
      expect(await jsonBody(response)).toMatchObject({
        success: false,
        code: 'SETUP_NOT_READY'
      })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await registrationSideEffects(db)).toEqual({
        verifications: 0,
        users: 0,
        accounts: 0,
        nextId: 0
      })
    }
  )

  it.each(['open', 'claimed'] as const)(
    'blocks email verification before reading private pending data while setup is %s',
    async (status) => {
      const { db, env } = await setupOpen()
      const email = `pending-${status}@example.test`
      const privateName = `Private Pending ${status}`
      const privatePassword = `private-sealed-password-${status}`
      const code = '123456'
      await db.prepare(
        `INSERT INTO email_verification
          (id, email, name, password, code_hash, expires_at, created_at, invite_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(
        crypto.randomUUID(),
        email,
        privateName,
        privatePassword,
        await hashPassword(code),
        Date.now() + 60_000,
        Date.now()
      ).run()
      if (status === 'claimed') await claimFirstSetup(db)

      const response = await postJson(env, '/api/auth/verify-email', { email, code })
      const responseText = await response.text()

      expect(response.status).toBe(409)
      expect(JSON.parse(responseText)).toMatchObject({
        success: false,
        code: 'SETUP_NOT_READY'
      })
      expect(responseText).not.toContain(privateName)
      expect(responseText).not.toContain(email)
      expect(responseText).not.toContain(privatePassword)
      expect(await db.prepare(
        'SELECT name, password FROM email_verification WHERE email = ?'
      ).bind(email).first()).toEqual({ name: privateName, password: privatePassword })
      expect(await db.prepare(
        'SELECT COUNT(*) AS n FROM rate_limit_bucket'
      ).first()).toEqual({ n: 0 })
      expect(await registrationSideEffects(db)).toMatchObject({
        users: 0,
        accounts: 0,
        nextId: 0
      })
    }
  )

  it.each(['open', 'claimed', 'claimed-orphan'] as const)(
    'routes page shells and page APIs to setup while first setup is %s',
    async (status) => {
      const { db, env } = await setupPageState(status)

      for (const path of ['/', '/login', '/register', '/verify-email']) {
        const response = await getPage(env, path)
        expect(response.status, path).toBe(302)
        expect(response.headers.get('location'), path).toBe('/setup')
      }

      const setupShell = await getPage(env, '/setup')
      expect(setupShell.status).toBe(200)
      expect(await setupShell.text()).toContain('data-page="setup"')

      for (const path of [
        '/api/pages/home',
        '/api/pages/login',
        '/api/pages/register'
      ]) {
        const response = await getPage(env, path)
        expect(response.status, path).toBe(200)
        expect(await jsonBody(response), path).toMatchObject({
          success: true,
          redirect: '/setup'
        })
      }

      const setupData = await getPage(env, '/api/pages/setup')
      expect(setupData.status).toBe(200)
      expect(await jsonBody(setupData)).toMatchObject({ success: true })
      expect(await getFirstSetupState(db)).toMatchObject({
        status: status === 'open' ? 'open' : 'claimed'
      })
      if (status === 'claimed-orphan') {
        expect(await db.prepare('SELECT COUNT(*) AS n FROM user').first()).toEqual({ n: 1 })
      }
    }
  )

  it('restores normal page navigation after first setup is completed', async () => {
    const { env } = await setupPageState('completed')

    const homeShell = await getPage(env, '/')
    expect(homeShell.status).toBe(302)
    expect(homeShell.headers.get('location')).toBe('/login')

    for (const [path, page] of [
      ['/login', 'login'],
      ['/register', 'register'],
      ['/verify-email', 'verify-email']
    ] as const) {
      const response = await getPage(env, path)
      expect(response.status, path).toBe(200)
      expect(await response.text(), path).toContain(`data-page="${page}"`)
    }

    const setupShell = await getPage(env, '/setup')
    expect(setupShell.status).toBe(302)
    expect(setupShell.headers.get('location')).toBe('/')

    const homeData = await getPage(env, '/api/pages/home')
    expect(homeData.status).toBe(401)
    expect(await jsonBody(homeData)).toMatchObject({
      success: false,
      redirect: '/login'
    })

    for (const path of ['/api/pages/login', '/api/pages/register']) {
      const response = await getPage(env, path)
      const body = await jsonBody(response)
      expect(response.status, path).toBe(200)
      expect(body, path).toMatchObject({ success: true })
      expect(body, path).not.toHaveProperty('redirect')
    }

    const setupData = await getPage(env, '/api/pages/setup')
    expect(setupData.status).toBe(200)
    expect(await jsonBody(setupData)).toMatchObject({
      success: true,
      redirect: '/'
    })
  })

  it('logs only allowlisted security events and returns only fixed errors', async () => {
    const { db, env } = await setupOpen()
    const privateValues = [
      'Private Setup Name',
      'private-setup@example.test',
      'private-password',
      'clear-token-private',
      'claim-hash-private',
      'private-cookie',
      '203.0.113.9',
      'private-user-agent',
      'private-stack'
    ]
    await db.prepare(
      `CREATE TRIGGER fail_private_setup_id
       BEFORE UPDATE ON user_id_counter
       BEGIN
         SELECT RAISE(ABORT, 'clear-token-private claim-hash-private private-stack');
       END`
    ).run()
    await db.prepare(
      `CREATE TRIGGER fail_private_setup_release
       BEFORE UPDATE ON first_setup
       WHEN OLD.status = 'claimed' AND NEW.status = 'open'
       BEGIN
         SELECT RAISE(ABORT, 'private-cookie 203.0.113.9 private-user-agent');
       END`
    ).run()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const headers = sameOriginJsonHeaders('csrf_token=test-csrf; private-cookie=secret')
    headers.set('user-agent', 'private-user-agent')
    headers.set('cf-connecting-ip', '203.0.113.9')

    const response = await postSetup(env, {
      name: privateValues[0],
      email: privateValues[1],
      password: privateValues[2],
      confirm: privateValues[2]
    }, headers)
    const responseText = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(responseText)).toMatchObject({
      success: false,
      code: 'SETUP_FAILED'
    })
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of errorSpy.mock.calls) {
      expect(call).toHaveLength(1)
      const serialized = String(call[0])
      const event = JSON.parse(serialized) as Record<string, unknown>
      expect(Object.keys(event).sort()).toEqual(['code', 'event', 'stage', 'timestamp'])
      expect(event.event).toBe('first_setup_security')
      expect(['SETUP_FAILED']).toContain(event.code)
      for (const privateValue of privateValues) {
        expect(serialized).not.toContain(privateValue)
      }
    }
    for (const privateValue of privateValues) {
      expect(responseText).not.toContain(privateValue)
    }
  })
})
