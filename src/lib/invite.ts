import type { Settings } from '../services/settings'
import { assertInviteCodeAvailable, consumeInviteCode } from '../services/invite-codes'

export async function requireInviteCodeIfNeeded(
  db: D1Database,
  settings: Settings,
  inviteCode: string
): Promise<{ ok: true; code: string | null } | { ok: false; message: string }> {
  if (!settings.invite_required) {
    return { ok: true, code: null }
  }
  const normalized = inviteCode.trim().toUpperCase()
  if (!normalized) {
    return { ok: false, message: '请填写邀请码' }
  }
  const check = await assertInviteCodeAvailable(db, normalized)
  if (!check.ok) {
    return { ok: false, message: check.message }
  }
  return { ok: true, code: normalized }
}

export async function findUserIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM user WHERE email = ? LIMIT 1')
    .bind(email)
    .first<{ id: string }>()
  return row?.id ?? null
}

export async function finalizeInviteUsage(
  db: D1Database,
  inviteCode: string | null | undefined,
  userId: string | null | undefined
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!inviteCode || !userId) return { ok: true }
  return await consumeInviteCode(db, inviteCode, userId)
}
