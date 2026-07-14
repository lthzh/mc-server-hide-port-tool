import type { UserListRow } from '../services/dns-records'

/** Mask a single email for admin UI display. DB keeps plaintext. */
export function maskEmail(email: string | null | undefined): string {
  const raw = String(email ?? '').trim()
  if (!raw) return ''

  // Standard email: keep first char of local + first char of domain label, mask the rest.
  const m = raw.match(/^([^@\s]+)@([^@\s]+)$/)
  if (!m) {
    // Non-email fallback: keep first 2 and last 2 chars.
    if (raw.length <= 4) return '*'.repeat(raw.length)
    return raw.slice(0, 2) + '*'.repeat(Math.min(6, raw.length - 4)) + raw.slice(-2)
  }

  const local = m[1]!
  const domain = m[2]!
  const localMask =
    local.length <= 1
      ? '*'
      : local[0] + '*'.repeat(Math.max(1, Math.min(6, local.length - 1)))

  const parts = domain.split('.')
  const maskedParts = parts.map((part, idx) => {
    if (!part) return part
    // Keep TLD mostly visible; mask earlier labels.
    if (idx === parts.length - 1 && parts.length > 1) {
      return part
    }
    if (part.length <= 1) return '*'
    return part[0] + '*'.repeat(Math.max(1, Math.min(6, part.length - 1)))
  })

  return localMask + '@' + maskedParts.join('.')
}

export type MaskedUserListRow = Omit<UserListRow, 'email'> & {
  email: string
  email_masked: true
}

export function maskUserForAdmin<T extends { email?: string | null }>(user: T): T & { email: string; email_masked: true } {
  return {
    ...user,
    email: maskEmail(user.email),
    email_masked: true as const
  }
}

export function maskUsersForAdmin<T extends { email?: string | null }>(users: T[]): Array<T & { email: string; email_masked: true }> {
  return users.map((u) => maskUserForAdmin(u))
}
