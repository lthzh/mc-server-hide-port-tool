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
  constructor(
    readonly code: OAuthRegistrationIntentErrorCode,
    readonly intentId?: string
  ) {
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

type RegistrationPolicyRow = {
  registration_enabled: number
  registration_mode: string
  invite_required: number
}

type InviteReservationRow = {
  id: string
  used_by: string | null
  revoked: number
  reserved_intent_id: string | null
}

export type OAuthRegistrationSecurityEvent = {
  event: 'oauth_registration_failed'
  intent_id: string | null
  provider_id: string
  failure_type: OAuthRegistrationIntentErrorCode | 'UNEXPECTED_FAILURE'
  at: number
  correlation_id?: string
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0)
}

function domainError(
  code: OAuthRegistrationIntentErrorCode,
  intentId?: string
): OAuthRegistrationIntentError {
  return new OAuthRegistrationIntentError(code, intentId)
}

async function readRegistrationPolicy(db: D1Database): Promise<RegistrationPolicyRow | null> {
  return await db.prepare(
    `SELECT registration_enabled, registration_mode, invite_required
     FROM settings WHERE id = 'default'`
  ).first<RegistrationPolicyRow>()
}

function assertOAuthRegistrationEnabled(policy: RegistrationPolicyRow | null): void {
  if (
    !policy ||
    policy.registration_enabled !== 1 ||
    (policy.registration_mode !== 'oauth' && policy.registration_mode !== 'both')
  ) {
    throw domainError('REGISTRATION_DISABLED')
  }
}

export function buildOAuthRegistrationIntentCookie(token: string, secure: boolean): string {
  return [
    `${OAUTH_REGISTRATION_INTENT_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

export function buildOAuthRegistrationIntentClearCookie(secure: boolean): string {
  return [
    `${OAUTH_REGISTRATION_INTENT_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : [])
  ].join('; ')
}

export async function createOAuthRegistrationIntent(
  db: D1Database,
  input: {
    providerId: string
    inviteRequired: boolean
    inviteCode: string
    now?: number
  }
): Promise<{ id: string; token: string; expiresAt: number }> {
  const providerId = input.providerId.trim()
  if (!providerId) throw domainError('PROVIDER_INVALID')

  const now = input.now ?? Date.now()
  const inviteCode = input.inviteCode.trim().toUpperCase()
  let inviteId: string | null = null
  if (input.inviteRequired) {
    if (!inviteCode) throw domainError('INVITE_REQUIRED')
    const invite = await db.prepare(
      `SELECT id, used_by, revoked, reserved_intent_id
       FROM invite_code WHERE code = ?`
    ).bind(inviteCode).first<InviteReservationRow>()
    if (!invite) throw domainError('INVITE_INVALID')
    if (invite.used_by || invite.revoked !== 0 || invite.reserved_intent_id) {
      throw domainError('INVITE_UNAVAILABLE')
    }
    inviteId = invite.id
  }

  const id = crypto.randomUUID()
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = now + OAUTH_REGISTRATION_INTENT_TTL_MS
  await db.prepare(
    `INSERT INTO oauth_registration_intent
      (id, token_hash, provider_id, oauth_state_hash, invite_code_id,
       created_at, expires_at, authorized_at, authorized_user_id, consumed_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`
  ).bind(id, tokenHash, providerId, inviteId, now, expiresAt).run()

  if (inviteId) {
    try {
      const reserved = await db.prepare(
        `UPDATE invite_code
         SET reserved_intent_id = ?, reserved_at = ?
         WHERE id = ?
           AND used_by IS NULL
           AND revoked = 0
           AND reserved_intent_id IS NULL`
      ).bind(id, now, inviteId).run()
      if (changes(reserved) !== 1) {
        await db.prepare(
          `DELETE FROM oauth_registration_intent
           WHERE id = ? AND authorized_at IS NULL AND consumed_at IS NULL`
        ).bind(id).run()
        throw domainError('INVITE_UNAVAILABLE', id)
      }
    } catch (error) {
      await db.prepare(
        `DELETE FROM oauth_registration_intent
         WHERE id = ? AND authorized_at IS NULL AND consumed_at IS NULL`
      ).bind(id).run().catch(() => undefined)
      if (error instanceof OAuthRegistrationIntentError) throw error
      throw error
    }
  }

  return { id, token, expiresAt }
}

export async function bindOAuthRegistrationIntentState(
  db: D1Database,
  input: {
    id: string
    token: string
    providerId: string
    state: string
    now?: number
  }
): Promise<void> {
  const providerId = input.providerId.trim()
  if (!providerId) throw domainError('PROVIDER_INVALID', input.id)
  if (!input.state) throw domainError('STATE_INVALID', input.id)
  if (!input.token) throw domainError('INTENT_REQUIRED', input.id)
  const now = input.now ?? Date.now()
  const [tokenHash, stateHash] = await Promise.all([
    sha256Hex(input.token),
    sha256Hex(input.state)
  ])
  const result = await db.prepare(
    `UPDATE oauth_registration_intent
     SET oauth_state_hash = ?
     WHERE id = ?
       AND token_hash = ?
       AND provider_id = ?
       AND oauth_state_hash IS NULL
       AND authorized_at IS NULL
       AND consumed_at IS NULL
       AND expires_at > ?`
  ).bind(stateHash, input.id, tokenHash, providerId, now).run()
  if (changes(result) !== 1) throw domainError('INTENT_INVALID', input.id)
}

async function diagnoseAuthorizationFailure(
  db: D1Database,
  input: {
    tokenHash: string
    stateHash: string
    providerId: string
    now: number
  }
): Promise<OAuthRegistrationIntentError> {
  const row = await db.prepare(
    `SELECT id, provider_id, oauth_state_hash, invite_code_id, expires_at,
            authorized_at, consumed_at
     FROM oauth_registration_intent WHERE token_hash = ?`
  ).bind(input.tokenHash).first<{
    id: string
    provider_id: string
    oauth_state_hash: string | null
    invite_code_id: string | null
    expires_at: number
    authorized_at: number | null
    consumed_at: number | null
  }>()
  if (!row) return domainError('INTENT_INVALID')
  if (row.consumed_at !== null || row.authorized_at !== null) {
    return domainError('INTENT_REPLAYED', row.id)
  }
  if (row.expires_at <= input.now) return domainError('INTENT_EXPIRED', row.id)
  if (row.provider_id !== input.providerId) return domainError('PROVIDER_INVALID', row.id)
  if (!row.oauth_state_hash || row.oauth_state_hash !== input.stateHash) {
    return domainError('STATE_INVALID', row.id)
  }

  const policy = await readRegistrationPolicy(db)
  try {
    assertOAuthRegistrationEnabled(policy)
  } catch {
    return domainError('REGISTRATION_DISABLED', row.id)
  }
  if (policy?.invite_required === 1 && !row.invite_code_id) {
    return domainError('INVITE_REQUIRED', row.id)
  }
  if (row.invite_code_id) {
    const invite = await db.prepare(
      `SELECT id FROM invite_code
       WHERE id = ?
         AND used_by IS NULL
         AND revoked = 0
         AND reserved_intent_id = ?`
    ).bind(row.invite_code_id, row.id).first<{ id: string }>()
    if (!invite) return domainError('INVITE_UNAVAILABLE', row.id)
  }
  return domainError('INTENT_INVALID', row.id)
}

export async function authorizeOAuthRegistrationIntent(
  db: D1Database,
  input: {
    token: string
    providerId: string
    state: string
    userId: string
    now?: number
  }
): Promise<{ intentId: string }> {
  if (!input.token) throw domainError('INTENT_REQUIRED')
  const providerId = input.providerId.trim()
  if (!providerId) throw domainError('PROVIDER_INVALID')
  if (!input.state) throw domainError('STATE_INVALID')
  if (!input.userId) throw domainError('INTENT_INVALID')
  const now = input.now ?? Date.now()
  const policy = await readRegistrationPolicy(db)
  assertOAuthRegistrationEnabled(policy)

  const [tokenHash, stateHash] = await Promise.all([
    sha256Hex(input.token),
    sha256Hex(input.state)
  ])
  let result: D1Result<unknown>
  try {
    result = await db.prepare(
      `UPDATE oauth_registration_intent
       SET authorized_at = ?, authorized_user_id = ?
       WHERE token_hash = ?
         AND provider_id = ?
         AND oauth_state_hash = ?
         AND authorized_at IS NULL
         AND authorized_user_id IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM settings
           WHERE id = 'default'
             AND registration_enabled = 1
             AND registration_mode IN ('oauth', 'both')
             AND (
               invite_required = 0
               OR oauth_registration_intent.invite_code_id IS NOT NULL
             )
         )
         AND (
           invite_code_id IS NULL OR EXISTS (
             SELECT 1 FROM invite_code
             WHERE invite_code.id = oauth_registration_intent.invite_code_id
               AND invite_code.used_by IS NULL
               AND invite_code.revoked = 0
               AND invite_code.reserved_intent_id = oauth_registration_intent.id
           )
         )`
    ).bind(now, input.userId, tokenHash, providerId, stateHash, now).run()
  } catch {
    throw await diagnoseAuthorizationFailure(db, {
      tokenHash,
      stateHash,
      providerId,
      now
    })
  }
  if (changes(result) !== 1) {
    throw await diagnoseAuthorizationFailure(db, {
      tokenHash,
      stateHash,
      providerId,
      now
    })
  }
  const row = await db.prepare(
    `SELECT id FROM oauth_registration_intent
     WHERE token_hash = ? AND authorized_user_id = ?`
  ).bind(tokenHash, input.userId).first<{ id: string }>()
  if (!row) throw domainError('INTENT_INVALID')
  return { intentId: row.id }
}

export async function consumeAuthorizedOAuthRegistrationIntent(
  db: D1Database,
  input: {
    userId: string
    token: string
    providerId: string
    state: string
    now?: number
  }
): Promise<void> {
  const providerId = input.providerId.trim()
  if (!input.userId || !input.token || !providerId || !input.state) {
    throw domainError('INTENT_FINALIZATION_FAILED')
  }
  const now = input.now ?? Date.now()
  const [tokenHash, stateHash] = await Promise.all([
    sha256Hex(input.token),
    sha256Hex(input.state)
  ])
  const existing = await db.prepare(
    `SELECT id, consumed_at FROM oauth_registration_intent
     WHERE authorized_user_id = ?
       AND token_hash = ?
       AND provider_id = ?
       AND oauth_state_hash = ?
       AND authorized_at IS NOT NULL`
  ).bind(
    input.userId,
    tokenHash,
    providerId,
    stateHash
  ).first<{ id: string; consumed_at: number | null }>()
  if (!existing) throw domainError('INTENT_FINALIZATION_FAILED')
  if (existing.consumed_at !== null) return

  try {
    const result = await db.prepare(
      `UPDATE oauth_registration_intent
       SET consumed_at = ?
       WHERE id = ?
         AND authorized_user_id = ?
         AND token_hash = ?
         AND provider_id = ?
         AND oauth_state_hash = ?
         AND authorized_at IS NOT NULL
         AND consumed_at IS NULL
       RETURNING id`
    ).bind(
      now,
      existing.id,
      input.userId,
      tokenHash,
      providerId,
      stateHash
    ).all<{ id: string }>()
    if ((result.results ?? []).length === 1) return
    const replay = await db.prepare(
      'SELECT consumed_at FROM oauth_registration_intent WHERE id = ?'
    ).bind(existing.id).first<{ consumed_at: number | null }>()
    if (replay?.consumed_at !== null && replay?.consumed_at !== undefined) return
  } catch {
    throw domainError('INTENT_FINALIZATION_FAILED', existing.id)
  }
  throw domainError('INTENT_FINALIZATION_FAILED', existing.id)
}

export async function releasePendingOAuthRegistrationIntent(
  db: D1Database,
  token: string | null | undefined
): Promise<boolean> {
  if (!token) return false
  const tokenHash = await sha256Hex(token)
  const result = await db.prepare(
    `DELETE FROM oauth_registration_intent
     WHERE token_hash = ?
       AND authorized_at IS NULL
       AND consumed_at IS NULL
     RETURNING id`
  ).bind(tokenHash).all<{ id: string }>()
  return (result.results ?? []).length === 1
}

async function finalizeAuthorizedIntentById(
  db: D1Database,
  id: string,
  now: number
): Promise<boolean> {
  try {
    const result = await db.prepare(
      `UPDATE oauth_registration_intent
       SET consumed_at = ?
       WHERE id = ?
         AND authorized_at IS NOT NULL
         AND authorized_user_id IS NOT NULL
         AND consumed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM user
           WHERE user.id = oauth_registration_intent.authorized_user_id
         )
       RETURNING id`
    ).bind(now, id).all<{ id: string }>()
    return (result.results ?? []).length === 1
  } catch {
    throw domainError('INTENT_FINALIZATION_FAILED', id)
  }
}

export async function cleanupOAuthRegistrationIntents(
  db: D1Database,
  now = Date.now()
): Promise<{
  releasedPending: number
  reconciled: number
  releasedAuthorized: number
  deletedConsumed: number
}> {
  const expiredPending = await db.prepare(
    `DELETE FROM oauth_registration_intent
     WHERE id IN (
       SELECT id FROM oauth_registration_intent
       WHERE authorized_at IS NULL
         AND consumed_at IS NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT 50
     )
       AND authorized_at IS NULL
       AND consumed_at IS NULL
       AND expires_at <= ?
     RETURNING id`
  ).bind(now, now).all<{ id: string }>()

  let reconciled = 0
  const authorizedWithUsers = await db.prepare(
    `SELECT id FROM oauth_registration_intent
     WHERE authorized_at IS NOT NULL
       AND consumed_at IS NULL
       AND authorized_user_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM user
         WHERE user.id = oauth_registration_intent.authorized_user_id
       )
     ORDER BY authorized_at ASC
     LIMIT 50`
  ).all<{ id: string }>()
  for (const row of authorizedWithUsers.results ?? []) {
    if (await finalizeAuthorizedIntentById(db, row.id, now)) reconciled += 1
  }

  let releasedAuthorized = 0
  const quarantineCutoff = now - OAUTH_REGISTRATION_AUTHORIZED_QUARANTINE_MS
  const staleAuthorized = await db.prepare(
    `SELECT id, invite_code_id FROM oauth_registration_intent
     WHERE authorized_at IS NOT NULL
       AND authorized_at <= ?
       AND consumed_at IS NULL
       AND authorized_user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user
         WHERE user.id = oauth_registration_intent.authorized_user_id
       )
     ORDER BY authorized_at ASC
     LIMIT 50`
  ).bind(quarantineCutoff).all<{ id: string; invite_code_id: string | null }>()

  for (const row of staleAuthorized.results ?? []) {
    const statements: D1PreparedStatement[] = []
    if (row.invite_code_id) {
      statements.push(db.prepare(
        `UPDATE invite_code
         SET reserved_intent_id = NULL, reserved_at = NULL
         WHERE id = ?
           AND used_by IS NULL
           AND reserved_intent_id = ?
           AND EXISTS (
             SELECT 1 FROM oauth_registration_intent
             WHERE oauth_registration_intent.id = ?
               AND oauth_registration_intent.authorized_at IS NOT NULL
               AND oauth_registration_intent.authorized_at <= ?
               AND oauth_registration_intent.consumed_at IS NULL
               AND oauth_registration_intent.authorized_user_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM user
                 WHERE user.id = oauth_registration_intent.authorized_user_id
               )
           )`
      ).bind(row.invite_code_id, row.id, row.id, quarantineCutoff))
    }
    statements.push(db.prepare(
      `DELETE FROM oauth_registration_intent
       WHERE id = ?
         AND authorized_at IS NOT NULL
         AND authorized_at <= ?
         AND consumed_at IS NULL
         AND authorized_user_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM user
           WHERE user.id = oauth_registration_intent.authorized_user_id
         )
         AND (
           invite_code_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM invite_code
             WHERE invite_code.id = oauth_registration_intent.invite_code_id
               AND invite_code.reserved_intent_id = oauth_registration_intent.id
           )
         )`
    ).bind(row.id, quarantineCutoff))
    const results = await db.batch(statements)
    if (changes(results[results.length - 1]!) === 1) releasedAuthorized += 1
  }

  const consumedCutoff = now - OAUTH_REGISTRATION_CONSUMED_RETENTION_MS
  const oldConsumed = await db.prepare(
    `DELETE FROM oauth_registration_intent
     WHERE id IN (
       SELECT id FROM oauth_registration_intent
       WHERE consumed_at IS NOT NULL
         AND consumed_at <= ?
       ORDER BY consumed_at ASC
       LIMIT 50
     )
       AND consumed_at IS NOT NULL
       AND consumed_at <= ?
     RETURNING id`
  ).bind(consumedCutoff, consumedCutoff).all<{ id: string }>()

  return {
    releasedPending: (expiredPending.results ?? []).length,
    reconciled,
    releasedAuthorized,
    deletedConsumed: (oldConsumed.results ?? []).length
  }
}

export function createOAuthRegistrationSecurityEvent(
  error: unknown,
  input: { providerId: string; at?: number; correlationId?: string }
): OAuthRegistrationSecurityEvent {
  const known = error instanceof OAuthRegistrationIntentError ? error : null
  return {
    event: 'oauth_registration_failed',
    intent_id: known?.intentId ?? null,
    provider_id: input.providerId.trim(),
    failure_type: known?.code ?? 'UNEXPECTED_FAILURE',
    at: input.at ?? Date.now(),
    ...(input.correlationId !== undefined
      ? { correlation_id: input.correlationId }
      : {})
  }
}
