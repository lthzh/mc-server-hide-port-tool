import { hashPassword, symmetricDecrypt, symmetricEncrypt, verifyPassword } from 'better-auth/crypto'

export type EmailVerificationRow = {
  id: string
  email: string
  name: string
  password: string
  code_hash: string
  expires_at: number
  created_at: number
  invite_code: string | null
}

const ENC_PREFIX = 'enc:v1:'

export async function hashVerificationCode(code: string): Promise<string> {
  return await hashPassword(code)
}

export async function verifyVerificationCode(code: string, codeHash: string): Promise<boolean> {
  // Support legacy sha256 hex hashes (64 lowercase hex chars) during transition.
  if (/^[a-f0-9]{64}$/i.test(codeHash)) {
    const data = new TextEncoder().encode(code)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex === codeHash.toLowerCase()
  }
  try {
    return await verifyPassword({ hash: codeHash, password: code })
  } catch {
    return false
  }
}

/** Encrypt pending signup password with app secret. */
export async function sealPendingPassword(secret: string | undefined, password: string): Promise<string> {
  if (!secret) {
    // Fallback keeps system working in misconfigured env, but is not ideal.
    return password
  }
  const cipher = await symmetricEncrypt({ key: secret, data: password })
  return `${ENC_PREFIX}${cipher}`
}

/** Decrypt pending signup password; supports legacy plaintext rows. */
export async function openPendingPassword(secret: string | undefined, stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored
  }
  if (!secret) {
    throw new Error('Cannot decrypt pending signup password: missing BETTER_AUTH_SECRET')
  }
  return await symmetricDecrypt({
    key: secret,
    data: stored.slice(ENC_PREFIX.length)
  })
}

export async function upsertEmailVerification(
  db: D1Database,
  input: {
    email: string
    name: string
    passwordSealed: string
    codeHash: string
    expiresAt: number
    inviteCode: string | null
  }
): Promise<string> {
  const id = crypto.randomUUID()
  const now = Date.now()
  // Replace any previous pending verification for this email.
  await db.prepare('DELETE FROM email_verification WHERE email = ?').bind(input.email).run()
  await db
    .prepare(
      `INSERT INTO email_verification
        (id, email, name, password, code_hash, expires_at, created_at, invite_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.email,
      input.name,
      input.passwordSealed,
      input.codeHash,
      input.expiresAt,
      now,
      input.inviteCode
    )
    .run()
  return id
}

export async function findLatestEmailVerification(
  db: D1Database,
  email: string
): Promise<EmailVerificationRow | null> {
  return await db
    .prepare(
      `SELECT id, email, name, password, code_hash, expires_at, created_at, invite_code
       FROM email_verification
       WHERE email = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(email)
    .first<EmailVerificationRow>()
}

export async function deleteEmailVerificationsByEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare('DELETE FROM email_verification WHERE email = ?').bind(email).run()
}

export async function purgeExpiredEmailVerifications(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM email_verification WHERE expires_at < ?').bind(now).run()
}
