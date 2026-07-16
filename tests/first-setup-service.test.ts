import { afterEach, describe, expect, it } from 'vitest'
import {
  FIRST_SETUP_CLAIM_TTL_MS,
  FirstSetupError,
  assertFirstSetupClaimActive,
  assertFirstSetupCompleted,
  bindFirstSetupUser,
  claimFirstSetup,
  createFirstSetupSecurityEvent,
  getFirstSetupState,
  reconcileFirstSetup,
  releaseOwnedFirstSetupClaim
} from '../src/services/first-setup'
import { createTestD1, disposeTestD1Instances, type TestD1 } from './helpers/d1'

const instances: TestD1[] = []

afterEach(async () => {
  await disposeTestD1Instances(instances)
})

async function setup(): Promise<TestD1> {
  const instance = await createTestD1()
  instances.push(instance)
  return instance
}

async function setupDb(): Promise<D1Database> {
  return (await setup()).db
}

async function disposeInstance(instance: TestD1): Promise<void> {
  const index = instances.indexOf(instance)
  if (index >= 0) instances.splice(index, 1)
  await instance.dispose()
}

async function rawHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    'SELECT claim_token_hash FROM first_setup WHERE id = 1'
  ).first<{ claim_token_hash: string | null }>()
  return row?.claim_token_hash ?? null
}

async function insertSetupUser(
  db: D1Database,
  input: { id?: string; role?: 'admin' | 'user'; superAdmin?: number } = {}
): Promise<string> {
  const id = input.id ?? '1'
  const now = Date.now()
  await db.prepare(
    `INSERT INTO user
     (id, name, email, emailVerified, createdAt, updatedAt, role, super_admin)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(
    id,
    'Setup Admin',
    'setup-' + id + '@example.test',
    now,
    now,
    input.role ?? 'admin',
    input.superAdmin ?? 1
  ).run()
  return id
}

async function insertCredential(db: D1Database, userId = '1'): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO account
     (id, accountId, providerId, userId, password, createdAt, updatedAt)
     VALUES (?, ?, 'credential', ?, 'hashed', ?, ?)`
  ).bind(crypto.randomUUID(), userId, userId, now, now).run()
}

async function countRows(db: D1Database, table: 'user' | 'account'): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM ' + table).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

describe('first setup claim service', () => {
  it('reads the initial open state', async () => {
    const db = await setupDb()
    expect(await getFirstSetupState(db)).toEqual({
      status: 'open', claimedAt: null, claimedUserId: null, completedAt: null
    })
  })

  it('stores only a SHA-256 hash of a 32-byte claim token', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    const bytes = Uint8Array.from(atob(claim.token), (char) => char.charCodeAt(0))
    expect(bytes).toHaveLength(32)
    expect(claim.expiresAt).toBe(1_000 + FIRST_SETUP_CLAIM_TTL_MS)
    const row = await db.prepare(
      'SELECT claim_token_hash, claimed_at FROM first_setup WHERE id = 1'
    ).first<{ claim_token_hash: string; claimed_at: number }>()
    expect(row?.claim_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.claim_token_hash).not.toBe(claim.token)
    expect(row?.claimed_at).toBe(1_000)
  })

  it('allows exactly one concurrent claimant without overwriting the winner hash', async () => {
    const db = await setupDb()
    const results = await Promise.allSettled([
      claimFirstSetup(db, 2_000),
      claimFirstSetup(db, 2_000)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection && rejection.status === 'rejected' && rejection.reason)
      .toMatchObject({ code: 'SETUP_IN_PROGRESS' })
    const firstHash = await rawHash(db)
    await expect(claimFirstSetup(db, 2_001)).rejects.toMatchObject({
      code: 'SETUP_IN_PROGRESS'
    })
    expect(await rawHash(db)).toBe(firstHash)
  })

  it('returns SETUP_DONE for completed state', async () => {
    const db = await setupDb()
    await db.prepare(
      "UPDATE first_setup SET status='completed', completed_at=1 WHERE id=1"
    ).run()
    await expect(claimFirstSetup(db, 2_000)).rejects.toMatchObject({ code: 'SETUP_DONE' })
  })

  it('fails closed and completes an open state when a user already exists', async () => {
    const db = await setupDb()
    await insertSetupUser(db)
    await expect(claimFirstSetup(db, 2_000)).rejects.toMatchObject({ code: 'SETUP_DONE' })
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'completed' })
  })

  it('validates and binds a live claim exactly once', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 10_000)
    await assertFirstSetupClaimActive(db, claim.token, 10_001)
    await bindFirstSetupUser(db, { token: claim.token, userId: '1', now: 10_001 })
    expect(await getFirstSetupState(db)).toMatchObject({
      status: 'claimed', claimedUserId: '1'
    })
    await expect(bindFirstSetupUser(db, {
      token: claim.token, userId: '2', now: 10_002
    })).rejects.toMatchObject({ code: 'SETUP_CLAIM_INVALID' })
    await expect(assertFirstSetupClaimActive(db, claim.token, 10_002))
      .rejects.toMatchObject({ code: 'SETUP_CLAIM_INVALID' })
  })

  it('rejects wrong and expired claim tokens', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 10_000)
    await expect(assertFirstSetupClaimActive(db, 'wrong-token', 10_001))
      .rejects.toMatchObject({ code: 'SETUP_CLAIM_INVALID' })
    await expect(assertFirstSetupClaimActive(
      db, claim.token, 10_000 + FIRST_SETUP_CLAIM_TTL_MS
    )).rejects.toMatchObject({ code: 'SETUP_CLAIM_INVALID' })
  })

  it('requires completed state for ordinary user creation', async () => {
    const db = await setupDb()
    await expect(assertFirstSetupCompleted(db)).rejects.toMatchObject({
      code: 'SETUP_NOT_READY'
    })
    await db.prepare(
      "UPDATE first_setup SET status='completed', completed_at=1 WHERE id=1"
    ).run()
    await expect(assertFirstSetupCompleted(db)).resolves.toBeUndefined()
  })

  it('releases an unbound owned claim and is idempotent', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    expect(await releaseOwnedFirstSetupClaim(db, claim.token)).toMatchObject({ status: 'open' })
    expect(await releaseOwnedFirstSetupClaim(db, claim.token)).toMatchObject({ status: 'open' })
  })

  it('does not release another owner claim', async () => {
    const db = await setupDb()
    await claimFirstSetup(db, 1_000)
    expect(await releaseOwnedFirstSetupClaim(db, 'wrong-owner')).toMatchObject({
      status: 'claimed'
    })
  })

  it('deletes an owned orphan user before reopening', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    await bindFirstSetupUser(db, { token: claim.token, userId: '1', now: 1_001 })
    await insertSetupUser(db)
    expect(await releaseOwnedFirstSetupClaim(db, claim.token)).toMatchObject({ status: 'open' })
    expect(await countRows(db, 'user')).toBe(0)
    expect(await countRows(db, 'account')).toBe(0)
  })

  it('never deletes or reopens a completed credential user', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    await bindFirstSetupUser(db, { token: claim.token, userId: '1', now: 1_001 })
    await insertSetupUser(db)
    await insertCredential(db)
    expect(await releaseOwnedFirstSetupClaim(db, claim.token)).toMatchObject({
      status: 'completed', claimedUserId: '1'
    })
    expect(await countRows(db, 'user')).toBe(1)
    expect(await countRows(db, 'account')).toBe(1)
  })

  it('keeps a live claim isolated and reopens a stale unbound claim', async () => {
    const db = await setupDb()
    await claimFirstSetup(db, 1_000)
    expect(await reconcileFirstSetup(db, 1_000 + FIRST_SETUP_CLAIM_TTL_MS - 1))
      .toMatchObject({ status: 'claimed' })
    expect(await reconcileFirstSetup(db, 1_000 + FIRST_SETUP_CLAIM_TTL_MS))
      .toMatchObject({ status: 'open' })
  })

  it('deletes a stale orphan user and reopens idempotently', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    await bindFirstSetupUser(db, { token: claim.token, userId: '1', now: 1_001 })
    await insertSetupUser(db)
    const staleNow = 1_000 + FIRST_SETUP_CLAIM_TTL_MS
    expect(await reconcileFirstSetup(db, staleNow)).toMatchObject({ status: 'open' })
    expect(await reconcileFirstSetup(db, staleNow + 1)).toMatchObject({ status: 'open' })
    expect(await countRows(db, 'user')).toBe(0)
  })

  it('reconciles a credential to completed if the trigger was unavailable', async () => {
    const db = await setupDb()
    const claim = await claimFirstSetup(db, 1_000)
    await bindFirstSetupUser(db, { token: claim.token, userId: '1', now: 1_001 })
    await insertSetupUser(db)
    await db.prepare('DROP TRIGGER first_setup_complete_on_credential').run()
    await insertCredential(db)
    expect(await getFirstSetupState(db)).toMatchObject({ status: 'claimed' })
    expect(await reconcileFirstSetup(db, 1_002)).toMatchObject({
      status: 'completed', claimedUserId: '1'
    })
  })

  it('allows cleanup and credential insertion to converge only to legal states', { timeout: 60_000 }, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const instance = await setup()
      try {
        const db = instance.db
        const claim = await claimFirstSetup(db, Date.now())
        await bindFirstSetupUser(db, { token: claim.token, userId: '1' })
        await insertSetupUser(db)
        await Promise.allSettled([
          releaseOwnedFirstSetupClaim(db, claim.token),
          insertCredential(db)
        ])
        const state = await getFirstSetupState(db)
        const observed = {
          status: state.status,
          users: await countRows(db, 'user'),
          credentials: Number((await db.prepare(
            "SELECT COUNT(*) AS count FROM account WHERE providerId = 'credential'"
          ).first<{ count: number }>())?.count ?? 0)
        }
        expect([
          { status: 'completed', users: 1, credentials: 1 },
          { status: 'open', users: 0, credentials: 0 }
        ]).toContainEqual(observed)
      } finally {
        await disposeInstance(instance)
      }
    }
  })

  it('serializes only allowlisted security event fields', () => {
    const secretError = Object.assign(new Error('raw-secret-message'), {
      email: 'private@example.test',
      token: 'clear-token',
      stack: 'secret-stack'
    })
    const event = createFirstSetupSecurityEvent(secretError, { stage: 'claim', now: 0 })
    expect(event).toEqual({
      event: 'first_setup_security',
      code: 'SETUP_FAILED',
      stage: 'claim',
      timestamp: '1970-01-01T00:00:00.000Z'
    })
    expect(Object.keys(event).sort()).toEqual(['code', 'event', 'stage', 'timestamp'])
    expect(JSON.stringify(event)).not.toMatch(/private|clear-token|raw-secret|secret-stack/)
  })

  it('preserves a known fixed error code in the security event', () => {
    expect(createFirstSetupSecurityEvent(
      new FirstSetupError('SETUP_IN_PROGRESS'),
      { stage: 'claim', now: 0 }
    )).toMatchObject({ code: 'SETUP_IN_PROGRESS' })
  })
})
