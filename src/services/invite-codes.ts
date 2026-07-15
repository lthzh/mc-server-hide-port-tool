export type InviteCodeRow = {
  id: string
  code: string
  created_by: string
  created_at: number
  used_by: string | null
  used_at: number | null
  revoked: number
  reserved_intent_id: string | null
  reserved_at: number | null
  creator_name?: string | null
  creator_email?: string | null
  used_name?: string | null
  used_email?: string | null
}

export function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`
}

export async function createInviteCode(
  db: D1Database,
  createdBy: string,
  code?: string
): Promise<InviteCodeRow> {
  const id = crypto.randomUUID()
  const value = (code ?? generateInviteCode()).trim().toUpperCase()
  const created_at = Date.now()
  await db
    .prepare(
      `INSERT INTO invite_code (id, code, created_by, created_at, used_by, used_at, revoked)
       VALUES (?, ?, ?, ?, NULL, NULL, 0)`
    )
    .bind(id, value, createdBy, created_at)
    .run()
  return {
    id,
    code: value,
    created_by: createdBy,
    created_at,
    used_by: null,
    used_at: null,
    revoked: 0,
    reserved_intent_id: null,
    reserved_at: null
  }
}

export async function listInviteCodes(db: D1Database): Promise<InviteCodeRow[]> {
  const result = await db
    .prepare(
      `SELECT
         i.id,
         i.code,
         i.created_by,
         i.created_at,
         i.used_by,
         i.used_at,
         i.revoked,
         i.reserved_intent_id,
         i.reserved_at,
         creator.name AS creator_name,
         creator.email AS creator_email,
         used.name AS used_name,
         used.email AS used_email
       FROM invite_code i
       LEFT JOIN user creator ON creator.id = i.created_by
       LEFT JOIN user used ON used.id = i.used_by
       ORDER BY i.created_at DESC`
    )
    .all<InviteCodeRow>()
  return result.results ?? []
}

export async function findInviteCodeByValue(
  db: D1Database,
  code: string
): Promise<InviteCodeRow | null> {
  const normalized = code.trim().toUpperCase()
  if (!normalized) return null
  return await db
    .prepare(
      `SELECT id, code, created_by, created_at, used_by, used_at, revoked,
              reserved_intent_id, reserved_at
       FROM invite_code
       WHERE code = ?`
    )
    .bind(normalized)
    .first<InviteCodeRow>()
}

export async function assertInviteCodeAvailable(
  db: D1Database,
  code: string
): Promise<{ ok: true; invite: InviteCodeRow } | { ok: false; message: string }> {
  const invite = await findInviteCodeByValue(db, code)
  if (!invite) {
    return { ok: false, message: '邀请码无效' }
  }
  if (invite.revoked) {
    return { ok: false, message: '邀请码已作废' }
  }
  if (invite.used_by) {
    return { ok: false, message: '邀请码已被使用' }
  }
  if (invite.reserved_intent_id) {
    return { ok: false, message: '邀请码正在使用中' }
  }
  return { ok: true, invite }
}

export async function consumeInviteCode(
  db: D1Database,
  code: string,
  userId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const check = await assertInviteCodeAvailable(db, code)
  if (!check.ok) return check
  const result = await db
    .prepare(
      `UPDATE invite_code
       SET used_by = ?, used_at = ?
       WHERE id = ?
         AND used_by IS NULL
         AND revoked = 0
         AND reserved_intent_id IS NULL`
    )
    .bind(userId, Date.now(), check.invite.id)
    .run()
  if (!result.success || (result.meta?.changes ?? 0) < 1) {
    const latest = await findInviteCodeByValue(db, code)
    if (latest?.reserved_intent_id) {
      return { ok: false, message: '邀请码正在使用中' }
    }
    return { ok: false, message: '邀请码已被使用或不可用' }
  }
  return { ok: true }
}

export async function revokeInviteCode(
  db: D1Database,
  id: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const row = await db
    .prepare(
      `SELECT id, used_by, revoked, reserved_intent_id
       FROM invite_code WHERE id = ?`
    )
    .bind(id)
    .first<{
      id: string
      used_by: string | null
      revoked: number
      reserved_intent_id: string | null
    }>()
  if (!row) return { ok: false, message: '邀请码不存在' }
  if (row.used_by) return { ok: false, message: '已使用的邀请码无法作废' }
  if (row.revoked) return { ok: true }
  if (row.reserved_intent_id) {
    return { ok: false, message: '邀请码正在使用中，暂时无法作废' }
  }
  const result = await db.prepare(
    `UPDATE invite_code
     SET revoked = 1
     WHERE id = ?
       AND used_by IS NULL
       AND revoked = 0
       AND reserved_intent_id IS NULL`
  ).bind(id).run()
  if (!result.success || (result.meta?.changes ?? 0) < 1) {
    const latest = await db.prepare(
      'SELECT used_by, revoked, reserved_intent_id FROM invite_code WHERE id = ?'
    ).bind(id).first<{
      used_by: string | null
      revoked: number
      reserved_intent_id: string | null
    }>()
    if (latest?.reserved_intent_id) {
      return { ok: false, message: '邀请码正在使用中，暂时无法作废' }
    }
    if (latest?.used_by) {
      return { ok: false, message: '已使用的邀请码无法作废' }
    }
    if (latest?.revoked) return { ok: true }
    return { ok: false, message: '邀请码不存在' }
  }
  return { ok: true }
}
