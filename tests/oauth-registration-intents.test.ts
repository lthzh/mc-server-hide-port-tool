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
