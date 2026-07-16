import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigrationFile,
  createTestD1,
  disposeTestD1Instances,
  markFirstSetupCompleted,
  type TestD1
} from './helpers/d1'

const instances: TestD1[] = []

afterEach(async () => {
  await disposeTestD1Instances(instances)
})

async function createThrough0010(): Promise<TestD1> {
  const instance = await createTestD1({ through: '0010_oauth_registration_intents.sql' })
  instances.push(instance)
  return instance
}

async function insertUser(
  db: D1Database,
  input: { id: string; role?: 'admin' | 'user'; superAdmin?: number }
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO user
     (id, name, email, emailVerified, createdAt, updatedAt, role, super_admin)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(
    input.id,
    'User ' + input.id,
    'user-' + input.id + '@example.test',
    now,
    now,
    input.role ?? 'admin',
    input.superAdmin ?? 1
  ).run()
}

async function insertAccount(
  db: D1Database,
  input: { id: string; userId: string; providerId: string }
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO account
     (id, accountId, providerId, userId, password, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.id,
    input.userId,
    input.providerId,
    input.userId,
    input.providerId === 'credential' ? 'hashed' : null,
    now,
    now
  ).run()
}

describe('first setup migration', () => {
  it('can stop before 0011 and apply it explicitly', async () => {
    const instance = await createThrough0010()
    expect(await instance.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'first_setup'"
    ).first()).toBeNull()

    await applyMigrationFile(instance.db, '0011_first_setup_claim.sql')
    expect(await instance.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'first_setup'"
    ).first()).toEqual({ name: 'first_setup' })
  })

  it('initializes an empty database as open', async () => {
    const instance = await createTestD1()
    instances.push(instance)
    expect(await instance.db.prepare(
      'SELECT status, claim_token_hash, claimed_at, claimed_user_id, completed_at FROM first_setup WHERE id = 1'
    ).first()).toEqual({
      status: 'open',
      claim_token_hash: null,
      claimed_at: null,
      claimed_user_id: null,
      completed_at: null
    })
  })

  it('initializes an existing database as completed without reopening setup', async () => {
    const instance = await createThrough0010()
    await insertUser(instance.db, { id: '9001' })
    await applyMigrationFile(instance.db, '0011_first_setup_claim.sql')
    const state = await instance.db.prepare(
      'SELECT status, claim_token_hash, claimed_at, claimed_user_id, completed_at FROM first_setup WHERE id = 1'
    ).first<Record<string, unknown>>()
    expect(state?.status).toBe('completed')
    expect(state?.claim_token_hash).toBeNull()
    expect(state?.claimed_at).toBeNull()
    expect(state?.claimed_user_id).toBeNull()
    expect(Number(state?.completed_at)).toBeGreaterThan(0)
  })

  it('enforces singleton and legal state combinations', async () => {
    const instance = await createTestD1()
    instances.push(instance)
    await expect(instance.db.prepare(
      "INSERT INTO first_setup (id, status) VALUES (2, 'open')"
    ).run()).rejects.toThrow()
    await expect(instance.db.prepare(
      "UPDATE first_setup SET status = 'claimed' WHERE id = 1"
    ).run()).rejects.toThrow()
    await expect(instance.db.prepare(
      "UPDATE first_setup SET completed_at = 1 WHERE id = 1"
    ).run()).rejects.toThrow()
    await expect(instance.db.prepare(
      'DELETE FROM first_setup WHERE id = 1'
    ).run()).rejects.toThrow(/first_setup_row_cannot_be_deleted/)
  })

  it('does not allow completed to reopen', async () => {
    const instance = await createThrough0010()
    await insertUser(instance.db, { id: '9001' })
    await applyMigrationFile(instance.db, '0011_first_setup_claim.sql')
    await expect(instance.db.prepare(
      "UPDATE first_setup SET status = 'open', completed_at = NULL WHERE id = 1"
    ).run()).rejects.toThrow(/first_setup_completed_is_final/)
  })

  it('completes only for the claimed super administrator credential', async () => {
    const instance = await createTestD1()
    instances.push(instance)
    const now = Date.now()
    await instance.db.prepare(
      "UPDATE first_setup SET status='claimed', claim_token_hash='hash', claimed_at=?, claimed_user_id='1' WHERE id=1"
    ).bind(now).run()
    await insertUser(instance.db, { id: '1' })

    await insertAccount(instance.db, { id: 'oauth', userId: '1', providerId: 'fixture' })
    expect((await instance.db.prepare('SELECT status FROM first_setup WHERE id=1').first())?.status)
      .toBe('claimed')

    await insertAccount(instance.db, { id: 'credential', userId: '1', providerId: 'credential' })
    expect(await instance.db.prepare(
      'SELECT status, claim_token_hash, claimed_user_id FROM first_setup WHERE id=1'
    ).first()).toEqual({ status: 'completed', claim_token_hash: null, claimed_user_id: '1' })
  })

  it.each([
    { label: 'wrong claimed user', claimedUserId: '2', role: 'admin' as const, superAdmin: 1 },
    { label: 'non-admin role', claimedUserId: '1', role: 'user' as const, superAdmin: 1 },
    { label: 'not super admin', claimedUserId: '1', role: 'admin' as const, superAdmin: 0 }
  ])('does not complete for $label', async ({ claimedUserId, role, superAdmin }) => {
    const instance = await createTestD1()
    instances.push(instance)
    const now = Date.now()
    await instance.db.prepare(
      "UPDATE first_setup SET status='claimed', claim_token_hash='hash', claimed_at=?, claimed_user_id=? WHERE id=1"
    ).bind(now, claimedUserId).run()
    await insertUser(instance.db, { id: '1', role, superAdmin })
    await insertAccount(instance.db, {
      id: crypto.randomUUID(), userId: '1', providerId: 'credential'
    })
    expect((await instance.db.prepare('SELECT status FROM first_setup WHERE id=1').first())?.status)
      .toBe('claimed')
  })

  it('marks an open fixture as completed only when explicitly requested', async () => {
    const instance = await createTestD1()
    instances.push(instance)
    await markFirstSetupCompleted(instance.db)
    const state = await instance.db.prepare(
      'SELECT status, claim_token_hash, completed_at FROM first_setup WHERE id = 1'
    ).first<{ status: string; claim_token_hash: string | null; completed_at: number }>()
    expect(state?.status).toBe('completed')
    expect(state?.claim_token_hash).toBeNull()
    expect(Number(state?.completed_at)).toBeGreaterThan(0)
  })

  it('contains no destructive schema statements', async () => {
    const sql = await readFile(resolve(process.cwd(), 'migrations/0011_first_setup_claim.sql'), 'utf8')
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+["']?user/i)
  })
})
