import { afterEach, describe, expect, it } from 'vitest'
import { createTestD1, seedInvite, seedUser, type TestD1 } from './helpers/d1'
import {
  assertInviteCodeAvailable,
  consumeInviteCode,
  createInviteCode,
  findInviteCodeByValue,
  listInviteCodes,
  revokeInviteCode
} from '../src/services/invite-codes'
import {
  OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS,
  OAUTH_REGISTRATION_CONSUMED_RETENTION_MS,
  OAuthRegistrationIntentError,
  authorizeOAuthRegistrationIntent,
  bindOAuthRegistrationIntentState,
  buildOAuthRegistrationIntentClearCookie,
  buildOAuthRegistrationIntentCookie,
  cleanupOAuthRegistrationIntents,
  consumeAuthorizedOAuthRegistrationIntent,
  createOAuthRegistrationIntent,
  createOAuthRegistrationSecurityEvent,
  releasePendingOAuthRegistrationIntent
} from '../src/services/oauth-registration-intents'

const instances: TestD1[] = []

async function database(): Promise<D1Database> {
  const instance = await createTestD1()
  instances.push(instance)
  return instance.db
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map(({ dispose }) => dispose()))
})

async function insertIntent(
  db: D1Database,
  input: {
    id: string
    inviteId?: string | null
    authorizedAt?: number | null
    userId?: string | null
  }
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO oauth_registration_intent
      (id, token_hash, provider_id, oauth_state_hash, invite_code_id,
       created_at, expires_at, authorized_at, authorized_user_id, consumed_at)
     VALUES (?, ?, 'fixture', ?, ?, ?, ?, ?, ?, NULL)`
  ).bind(
    input.id,
    input.id.padEnd(64, '0').slice(0, 64),
    input.authorizedAt == null ? null : input.id.padEnd(64, '1').slice(0, 64),
    input.inviteId ?? null,
    now,
    now + 600_000,
    input.authorizedAt ?? null,
    input.userId ?? null
  ).run()
}

describe('0010 OAuth registration intent migration', () => {
  it('adds the intent and invite reservation columns', async () => {
    const db = await database()
    const intentColumns = await db.prepare(
      `PRAGMA table_info('oauth_registration_intent')`
    ).all<{ name: string }>()
    expect(intentColumns.results.map(({ name }) => name)).toEqual([
      'id',
      'token_hash',
      'provider_id',
      'oauth_state_hash',
      'invite_code_id',
      'created_at',
      'expires_at',
      'authorized_at',
      'authorized_user_id',
      'consumed_at'
    ])

    const inviteColumns = await db.prepare(
      `PRAGMA table_info('invite_code')`
    ).all<{ name: string }>()
    expect(inviteColumns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['reserved_intent_id', 'reserved_at'])
    )
  })

  it('atomically consumes a matching invite when the intent is finalized', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const userId = await seedUser(db, {
      id: '9002',
      email: 'oauth-user@example.test',
      name: 'OAuth User'
    })
    const invite = await seedInvite(db, creatorId)
    const intentId = 'intent-consume'
    const authorizedAt = Date.now()
    await insertIntent(db, {
      id: intentId,
      inviteId: invite.id,
      authorizedAt,
      userId
    })
    await db.prepare(
      'UPDATE invite_code SET reserved_intent_id = ?, reserved_at = ? WHERE id = ?'
    ).bind(intentId, authorizedAt, invite.id).run()

    const consumedAt = authorizedAt + 1
    await db.prepare(
      'UPDATE oauth_registration_intent SET consumed_at = ? WHERE id = ?'
    ).bind(consumedAt, intentId).run()

    const row = await db.prepare(
      `SELECT used_by, used_at, reserved_intent_id, reserved_at
       FROM invite_code WHERE id = ?`
    ).bind(invite.id).first<{
      used_by: string | null
      used_at: number | null
      reserved_intent_id: string | null
      reserved_at: number | null
    }>()
    expect(row).toEqual({
      used_by: userId,
      used_at: consumedAt,
      reserved_intent_id: null,
      reserved_at: null
    })
  })

  it('rejects finalization when the invite reservation no longer matches', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const userId = await seedUser(db, {
      id: '9002',
      email: 'oauth-user@example.test'
    })
    const invite = await seedInvite(db, creatorId)
    await insertIntent(db, {
      id: 'intent-mismatch',
      inviteId: invite.id,
      authorizedAt: Date.now(),
      userId
    })

    await expect(
      db.prepare(
        'UPDATE oauth_registration_intent SET consumed_at = ? WHERE id = ?'
      ).bind(Date.now(), 'intent-mismatch').run()
    ).rejects.toThrow('oauth_invite_reservation_invalid')
  })

  it('rejects finalization before authorization', async () => {
    const db = await database()
    await insertIntent(db, { id: 'intent-pending' })

    await expect(
      db.prepare(
        'UPDATE oauth_registration_intent SET consumed_at = ? WHERE id = ?'
      ).bind(Date.now(), 'intent-pending').run()
    ).rejects.toThrow('oauth_intent_not_authorized')
  })

  it('releases only pending reservations when intents are deleted', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const pendingInvite = await seedInvite(db, creatorId, {
      id: 'invite-pending',
      code: 'INVITE-PENDING'
    })
    const authorizedInvite = await seedInvite(db, creatorId, {
      id: 'invite-authorized',
      code: 'INVITE-AUTHORIZED'
    })
    const authorizedUserId = await seedUser(db, {
      id: '9002',
      email: 'oauth-user@example.test'
    })

    await insertIntent(db, {
      id: 'intent-pending-delete',
      inviteId: pendingInvite.id
    })
    await insertIntent(db, {
      id: 'intent-authorized-delete',
      inviteId: authorizedInvite.id,
      authorizedAt: Date.now(),
      userId: authorizedUserId
    })
    await db.prepare(
      `UPDATE invite_code SET reserved_intent_id = ?, reserved_at = ? WHERE id = ?`
    ).bind('intent-pending-delete', Date.now(), pendingInvite.id).run()
    await db.prepare(
      `UPDATE invite_code SET reserved_intent_id = ?, reserved_at = ? WHERE id = ?`
    ).bind('intent-authorized-delete', Date.now(), authorizedInvite.id).run()

    await db.prepare('DELETE FROM oauth_registration_intent WHERE id = ?')
      .bind('intent-pending-delete').run()
    await db.prepare('DELETE FROM oauth_registration_intent WHERE id = ?')
      .bind('intent-authorized-delete').run()

    const pending = await db.prepare(
      'SELECT reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(pendingInvite.id).first<{ reserved_intent_id: string | null }>()
    const authorized = await db.prepare(
      'SELECT reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(authorizedInvite.id).first<{ reserved_intent_id: string | null }>()
    expect(pending?.reserved_intent_id).toBeNull()
    expect(authorized?.reserved_intent_id).toBe('intent-authorized-delete')
  })
})

describe('reserved invite compatibility', () => {
  it('blocks availability, ordinary consumption, and revocation while reserved', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    await db.prepare(
      `UPDATE invite_code
       SET reserved_intent_id = 'intent-active', reserved_at = ?
       WHERE id = ?`
    ).bind(Date.now(), invite.id).run()

    await expect(assertInviteCodeAvailable(db, invite.code)).resolves.toEqual({
      ok: false,
      message: '邀请码正在使用中'
    })
    await expect(consumeInviteCode(db, invite.code, '9002')).resolves.toEqual({
      ok: false,
      message: '邀请码正在使用中'
    })
    await expect(revokeInviteCode(db, invite.id)).resolves.toEqual({
      ok: false,
      message: '邀请码正在使用中，暂时无法作废'
    })
  })

  it('returns reservation fields from create, list, and find operations', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const created = await createInviteCode(db, creatorId, 'FRESH-INVITE')
    expect(created).toMatchObject({
      reserved_intent_id: null,
      reserved_at: null
    })

    const found = await findInviteCodeByValue(db, created.code)
    expect(found).toMatchObject({
      reserved_intent_id: null,
      reserved_at: null
    })

    const listed = await listInviteCodes(db)
    expect(listed.find(({ id }) => id === created.id)).toMatchObject({
      reserved_intent_id: null,
      reserved_at: null
    })
  })
})

async function setOAuthRegistrationPolicy(
  db: D1Database,
  input: { enabled?: boolean; mode?: 'email' | 'oauth' | 'both'; inviteRequired?: boolean }
): Promise<void> {
  await db.prepare(
    `UPDATE settings
     SET registration_enabled = ?, registration_mode = ?, invite_required = ?
     WHERE id = 'default'`
  ).bind(
    input.enabled === false ? 0 : 1,
    input.mode ?? 'oauth',
    input.inviteRequired ? 1 : 0
  ).run()
}

async function hashFixture(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}

async function createBoundIntent(
  db: D1Database,
  input: {
    providerId?: string
    inviteRequired?: boolean
    inviteCode?: string
    state?: string
    now?: number
  } = {}
) {
  const providerId = input.providerId ?? 'fixture'
  const state = input.state ?? 'oauth-state'
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
    state,
    now: input.now
  })
  return { ...intent, providerId, state }
}

describe('OAuth registration intent lifecycle', () => {
  it('stores only hashes and builds a short-lived secure cookie', async () => {
    const db = await database()
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: 'fixture',
      inviteRequired: false,
      inviteCode: ''
    })
    expect(intent.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const row = await db.prepare(
      'SELECT token_hash FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first<{ token_hash: string }>()
    expect(row?.token_hash).toBe(await hashFixture(intent.token))
    expect(row?.token_hash).not.toContain(intent.token)

    expect(buildOAuthRegistrationIntentCookie(intent.token, true)).toBe(
      `oauth_registration_intent=${intent.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`
    )
    expect(buildOAuthRegistrationIntentCookie(intent.token, false)).not.toContain('Secure')
    expect(buildOAuthRegistrationIntentClearCookie(true)).toBe(
      'oauth_registration_intent=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'
    )
  })

  it('allows only one concurrent reservation for the same invite', async () => {
    const db = await database()
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    const results = await Promise.allSettled([
      createOAuthRegistrationIntent(db, {
        providerId: 'fixture', inviteRequired: true, inviteCode: invite.code
      }),
      createOAuthRegistrationIntent(db, {
        providerId: 'fixture', inviteRequired: true, inviteCode: invite.code
      })
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'INVITE_UNAVAILABLE' })
    })
    const count = await db.prepare(
      'SELECT COUNT(*) AS count FROM oauth_registration_intent'
    ).first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('binds OAuth state exactly once', async () => {
    const db = await database()
    const intent = await createOAuthRegistrationIntent(db, {
      providerId: 'fixture', inviteRequired: false, inviteCode: ''
    })
    await bindOAuthRegistrationIntentState(db, {
      id: intent.id,
      token: intent.token,
      providerId: 'fixture',
      state: 'oauth-state'
    })
    await expect(bindOAuthRegistrationIntentState(db, {
      id: intent.id,
      token: intent.token,
      providerId: 'fixture',
      state: 'replacement-state'
    })).rejects.toMatchObject({ code: 'INTENT_INVALID' })
  })

  it('rejects callback mismatches, expiry, replay, policy changes, and lost reservations', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: false })
    const intent = await createBoundIntent(db)

    await expect(authorizeOAuthRegistrationIntent(db, {
      token: 'wrong-token', providerId: 'fixture', state: intent.state, userId: '9101'
    })).rejects.toMatchObject({ code: 'INTENT_INVALID' })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: intent.token, providerId: 'wrong-provider', state: intent.state, userId: '9101'
    })).rejects.toMatchObject({ code: 'PROVIDER_INVALID' })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: intent.token, providerId: 'fixture', state: 'wrong-state', userId: '9101'
    })).rejects.toMatchObject({ code: 'STATE_INVALID' })

    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token, providerId: 'fixture', state: intent.state, userId: '9101'
    })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: intent.token, providerId: 'fixture', state: intent.state, userId: '9101'
    })).rejects.toMatchObject({ code: 'INTENT_REPLAYED' })

    const oldNow = 1_000_000
    const expired = await createBoundIntent(db, { now: oldNow, state: 'expired-state' })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: expired.token,
      providerId: expired.providerId,
      state: expired.state,
      userId: '9102',
      now: oldNow + 600_001
    })).rejects.toMatchObject({ code: 'INTENT_EXPIRED' })

    const disabled = await createBoundIntent(db, { state: 'disabled-state' })
    await setOAuthRegistrationPolicy(db, { enabled: false, mode: 'oauth' })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: disabled.token,
      providerId: disabled.providerId,
      state: disabled.state,
      userId: '9103'
    })).rejects.toMatchObject({ code: 'REGISTRATION_DISABLED' })

    const emailOnly = await createBoundIntent(db, { state: 'email-state' })
    await setOAuthRegistrationPolicy(db, { mode: 'email' })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: emailOnly.token,
      providerId: emailOnly.providerId,
      state: emailOnly.state,
      userId: '9104'
    })).rejects.toMatchObject({ code: 'REGISTRATION_DISABLED' })

    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    const lost = await createBoundIntent(db, {
      inviteRequired: true,
      inviteCode: invite.code,
      state: 'lost-reservation'
    })
    await db.prepare(
      'UPDATE invite_code SET reserved_intent_id = NULL, reserved_at = NULL WHERE id = ?'
    ).bind(invite.id).run()
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: lost.token,
      providerId: lost.providerId,
      state: lost.state,
      userId: '9105'
    })).rejects.toMatchObject({ code: 'INVITE_UNAVAILABLE' })
  })

  it('rechecks whether the latest policy requires an invite', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: false })
    const allowed = await createBoundIntent(db, { state: 'invite-free' })
    await authorizeOAuthRegistrationIntent(db, {
      token: allowed.token,
      providerId: allowed.providerId,
      state: allowed.state,
      userId: '9201'
    })

    const rejected = await createBoundIntent(db, { state: 'invite-now-required' })
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    await expect(authorizeOAuthRegistrationIntent(db, {
      token: rejected.token,
      providerId: rejected.providerId,
      state: rejected.state,
      userId: '9202'
    })).rejects.toMatchObject({ code: 'INVITE_REQUIRED' })
  })

  it('finalizes idempotently and atomically assigns the invite', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const userId = await seedUser(db, {
      id: '9301', email: 'final-user@example.test'
    })
    const invite = await seedInvite(db, creatorId)
    const intent = await createBoundIntent(db, {
      inviteRequired: true,
      inviteCode: invite.code
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state,
      userId
    })
    const input = {
      userId,
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state
    }
    await consumeAuthorizedOAuthRegistrationIntent(db, input)
    await consumeAuthorizedOAuthRegistrationIntent(db, input)

    const row = await db.prepare(
      'SELECT consumed_at FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first<{ consumed_at: number | null }>()
    const used = await db.prepare(
      `SELECT used_by, reserved_intent_id FROM invite_code WHERE id = ?`
    ).bind(invite.id).first<{
      used_by: string | null
      reserved_intent_id: string | null
    }>()
    expect(row?.consumed_at).not.toBeNull()
    expect(used).toEqual({ used_by: userId, reserved_intent_id: null })
  })

  it('releases pending reservations but never directly releases authorized ones', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const pendingInvite = await seedInvite(db, creatorId, {
      id: 'pending-release-invite', code: 'PENDING-RELEASE'
    })
    const pending = await createBoundIntent(db, {
      inviteRequired: true, inviteCode: pendingInvite.code, state: 'pending-release'
    })
    await expect(releasePendingOAuthRegistrationIntent(db, pending.token)).resolves.toBe(true)

    const authorizedInvite = await seedInvite(db, creatorId, {
      id: 'authorized-release-invite', code: 'AUTHORIZED-RELEASE'
    })
    const authorized = await createBoundIntent(db, {
      inviteRequired: true,
      inviteCode: authorizedInvite.code,
      state: 'authorized-release'
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: authorized.token,
      providerId: authorized.providerId,
      state: authorized.state,
      userId: '9401'
    })
    await expect(releasePendingOAuthRegistrationIntent(db, authorized.token)).resolves.toBe(false)

    const rows = await db.prepare(
      `SELECT id, reserved_intent_id FROM invite_code
       WHERE id IN (?, ?) ORDER BY id`
    ).bind(pendingInvite.id, authorizedInvite.id).all<{
      id: string
      reserved_intent_id: string | null
    }>()
    expect(rows.results).toEqual([
      { id: authorizedInvite.id, reserved_intent_id: authorized.id },
      { id: pendingInvite.id, reserved_intent_id: null }
    ])
  })

  it('counts expired pending intents rather than trigger side effects', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId, {
      id: 'expired-pending-invite', code: 'EXPIRED-PENDING'
    })
    const pending = await createBoundIntent(db, {
      inviteRequired: true, inviteCode: invite.code, state: 'expired-pending'
    })

    const result = await cleanupOAuthRegistrationIntents(db, pending.expiresAt)

    expect(result.releasedPending).toBe(1)
    const inviteRow = await db.prepare(
      'SELECT reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{ reserved_intent_id: string | null }>()
    expect(inviteRow?.reserved_intent_id).toBeNull()
  })

  it('reconciles an authorized intent when its user exists', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    const now = 10_000_000
    const intent = await createBoundIntent(db, {
      inviteRequired: true, inviteCode: invite.code, now
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state,
      userId: '9501',
      now
    })
    await seedUser(db, { id: '9501', email: 'reconcile-user@example.test' })

    const result = await cleanupOAuthRegistrationIntents(db, now + 1)
    expect(result.reconciled).toBe(1)
    const inviteRow = await db.prepare(
      'SELECT used_by FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{ used_by: string | null }>()
    expect(inviteRow?.used_by).toBe('9501')
  })

  it('quarantines an authorized intent before releasing it after confirmed user absence', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const invite = await seedInvite(db, creatorId)
    const now = 20_000_000
    const intent = await createBoundIntent(db, {
      inviteRequired: true, inviteCode: invite.code, now
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state,
      userId: '9601',
      now
    })

    const early = await cleanupOAuthRegistrationIntents(
      db,
      now + OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS - 1
    )
    expect(early.releasedAuthorized).toBe(0)
    expect(await db.prepare(
      'SELECT id FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first()).not.toBeNull()

    const late = await cleanupOAuthRegistrationIntents(
      db,
      now + OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS + 1
    )
    expect(late.releasedAuthorized).toBe(1)
    expect(await db.prepare(
      'SELECT id FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first()).toBeNull()
    const inviteRow = await db.prepare(
      'SELECT reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{ reserved_intent_id: string | null }>()
    expect(inviteRow?.reserved_intent_id).toBeNull()
  })

  it('deletes old consumed intents without changing invite ownership', async () => {
    const db = await database()
    await setOAuthRegistrationPolicy(db, { mode: 'oauth', inviteRequired: true })
    const creatorId = await seedUser(db)
    const userId = await seedUser(db, {
      id: '9701', email: 'retained-user@example.test'
    })
    const invite = await seedInvite(db, creatorId)
    const now = 30_000_000
    const intent = await createBoundIntent(db, {
      inviteRequired: true, inviteCode: invite.code, now
    })
    await authorizeOAuthRegistrationIntent(db, {
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state,
      userId,
      now
    })
    await consumeAuthorizedOAuthRegistrationIntent(db, {
      userId,
      token: intent.token,
      providerId: intent.providerId,
      state: intent.state,
      now
    })

    const result = await cleanupOAuthRegistrationIntents(
      db,
      now + OAUTH_REGISTRATION_CONSUMED_RETENTION_MS + 1
    )
    expect(result.deletedConsumed).toBe(1)
    expect(await db.prepare(
      'SELECT id FROM oauth_registration_intent WHERE id = ?'
    ).bind(intent.id).first()).toBeNull()
    const inviteRow = await db.prepare(
      'SELECT used_by FROM invite_code WHERE id = ?'
    ).bind(invite.id).first<{ used_by: string | null }>()
    expect(inviteRow?.used_by).toBe(userId)
  })

  it('serializes security failures without secrets or identity fields', () => {
    const clearToken = 'clear-cookie-token-fixture'
    const clearInvite = 'CLEAR-INVITE-FIXTURE'
    const error = new OAuthRegistrationIntentError('STATE_INVALID', 'intent-safe-id')
    Object.assign(error, {
      unsafeContext: `${clearToken}:${clearInvite}:person@example.test`
    })
    const serialized = JSON.stringify(createOAuthRegistrationSecurityEvent(error, {
      providerId: ' fixture ',
      at: 123,
      correlationId: 'correlation-1'
    }))
    expect(JSON.parse(serialized)).toEqual({
      event: 'oauth_registration_failed',
      intent_id: 'intent-safe-id',
      provider_id: 'fixture',
      failure_type: 'STATE_INVALID',
      at: 123,
      correlation_id: 'correlation-1'
    })
    expect(serialized).not.toContain(clearToken)
    expect(serialized).not.toContain(clearInvite)
    expect(serialized).not.toContain('person@example.test')
    expect(serialized).not.toMatch(/authorization|access|refresh|email|token/i)
  })
})
