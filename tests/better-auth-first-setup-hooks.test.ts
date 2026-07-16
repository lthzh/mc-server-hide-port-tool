import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuth, type AuthBindings } from '../src/auth'
import {
  bindOAuthRegistrationIntentState,
  createOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'
import {
  claimFirstSetup,
  getFirstSetupState
} from '../src/services/first-setup'
import {
  createTestD1,
  disposeTestD1Instances,
  markFirstSetupCompleted,
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

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeTestD1Instances(instances)
})

async function setupOpen() {
  const instance = await createTestD1()
  instances.push(instance)
  const env: AuthBindings = {
    DB: instance.db,
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: AUTH_ORIGIN,
    APP_NAME: 'Test App'
  }
  return { db: instance.db, env }
}

async function counts(db: D1Database) {
  const [users, accounts, counter] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM user').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM account').first<{ count: number }>(),
    db.prepare("SELECT value FROM user_id_counter WHERE name = 'user'").first<{ value: number }>()
  ])
  return {
    users: Number(users?.count ?? 0),
    accounts: Number(accounts?.count ?? 0),
    nextId: Number(counter?.value ?? 0)
  }
}

async function expectFixedFailure(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action
    throw new Error('expected auth operation to fail')
  } catch (error) {
    expect(String(error)).toContain(code)
  }
}

describe('Better Auth first setup hooks', { timeout: 30_000 }, () => {
  it('blocks ordinary email creation while setup is open before allocating an id', async () => {
    const { db, env } = await setupOpen()
    const auth = await createAuth(env)
    await expectFixedFailure(auth.api.signUpEmail({
      body: { name: 'Blocked', email: 'blocked-open@example.test', password: 'password123' }
    }), 'SETUP_NOT_READY')
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, nextId: 0 })
  })

  it('blocks ordinary email creation while setup is claimed before allocating an id', async () => {
    const { db, env } = await setupOpen()
    await claimFirstSetup(db)
    const auth = await createAuth(env)
    await expectFixedFailure(auth.api.signUpEmail({
      body: { name: 'Blocked', email: 'blocked-claimed@example.test', password: 'password123' }
    }), 'SETUP_NOT_READY')
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, nextId: 0 })
  })

  it('creates the claimed user as super administrator and completes on credential insert', async () => {
    const { db, env } = await setupOpen()
    const claim = await claimFirstSetup(db)
    const auth = await createAuth(env, undefined, { firstSetupClaimToken: claim.token })
    const result = await auth.api.signUpEmail({
      body: {
        name: 'Setup Admin',
        email: 'setup-admin@example.test',
        password: 'password123'
      }
    })
    expect(result.user.id).toBe('1')
    expect(await db.prepare(
      'SELECT role, super_admin FROM user WHERE id = ?'
    ).bind(result.user.id).first()).toEqual({ role: 'admin', super_admin: 1 })
    expect(await getFirstSetupState(db)).toMatchObject({
      status: 'completed', claimedUserId: result.user.id
    })
  })

  it('rejects an invalid setup token without allocating an id', async () => {
    const { db, env } = await setupOpen()
    await claimFirstSetup(db)
    const auth = await createAuth(env, undefined, { firstSetupClaimToken: 'wrong-token' })
    await expectFixedFailure(auth.api.signUpEmail({
      body: { name: 'Blocked', email: 'invalid-claim@example.test', password: 'password123' }
    }), 'SETUP_CLAIM_INVALID')
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, nextId: 0 })
  })

  it('rejects an expired setup token without allocating an id', async () => {
    const { db, env } = await setupOpen()
    const claim = await claimFirstSetup(db, 1)
    const auth = await createAuth(env, undefined, { firstSetupClaimToken: claim.token })
    await expectFixedFailure(auth.api.signUpEmail({
      body: { name: 'Blocked', email: 'expired-claim@example.test', password: 'password123' }
    }), 'SETUP_CLAIM_INVALID')
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, nextId: 0 })
  })

  it('cannot reuse a setup context after the first administrator completes', async () => {
    const { db, env } = await setupOpen()
    const claim = await claimFirstSetup(db)
    const auth = await createAuth(env, undefined, { firstSetupClaimToken: claim.token })
    await auth.api.signUpEmail({
      body: { name: 'Setup Admin', email: 'setup-once@example.test', password: 'password123' }
    })
    await expectFixedFailure(auth.api.signUpEmail({
      body: { name: 'Second', email: 'setup-twice@example.test', password: 'password123' }
    }), 'SETUP_CLAIM_INVALID')
    expect(await counts(db)).toMatchObject({ users: 1, accounts: 1, nextId: 1 })
  })

  it('keeps ordinary email signup behavior after setup is completed', async () => {
    const { db, env } = await setupOpen()
    await markFirstSetupCompleted(db)
    const auth = await createAuth(env)
    const result = await auth.api.signUpEmail({
      body: { name: 'Email User', email: 'email-user@example.test', password: 'password123' }
    })
    expect(result.user.id).toBe('1')
    expect(await db.prepare(
      'SELECT role, super_admin FROM user WHERE id = ?'
    ).bind(result.user.id).first()).toEqual({ role: 'user', super_admin: 0 })
  })

  it('fails closed when setup context and OAuth registration context coexist', async () => {
    const { db, env } = await setupOpen()
    await setRegistrationPolicy(db, { enabled: true, mode: 'both', inviteRequired: false })
    await seedFixtureOAuthProvider(db)
    const claim = await claimFirstSetup(db)
    const auth = await createAuth(env, undefined, { firstSetupClaimToken: claim.token })
    mockOAuthProviderFetch()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const start = await auth.api.signInWithOAuth2({
      headers: sameOriginJsonHeaders(),
      body: {
        providerId: 'fixture', callbackURL: '/done', errorCallbackURL: '/error',
        disableRedirect: true, requestSignUp: true
      },
      asResponse: true
    })
    const startBody = await start.json() as { url: string }
    const state = new URL(startBody.url).searchParams.get('state') ?? ''
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: 'fixture', inviteRequired: false, inviteCode: ''
    })
    await bindOAuthRegistrationIntentState(db, {
      id: intent.id, token: intent.token, providerId: 'fixture', state
    })

    await auth.handler(new Request(
      AUTH_ORIGIN + '/api/auth/oauth2/callback/fixture?code=test-code&state=' + encodeURIComponent(state),
      {
        headers: {
          cookie: mergeCookieHeaders(
            cookiesFromHeaders(start.headers),
            'oauth_registration_intent=' + intent.token
          )
        }
      }
    ))

    expect(await counts(db)).toEqual({ users: 0, accounts: 0, nextId: 0 })
    expect(await db.prepare(
      'SELECT authorized_at, consumed_at FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first()).toEqual({ authorized_at: null, consumed_at: null })
  })
})
