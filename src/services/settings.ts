export type Settings = {
  registration_enabled: boolean
  registration_mode: 'email' | 'oauth' | 'both'
  invite_required: boolean
  email_whitelist_enabled: boolean
  email_whitelist_suffixes: string[]
  email_blacklist_enabled: boolean
  email_blacklist_suffixes: string[]
  github_min_account_age_days: number
  resend_enabled: boolean
  resend_api_key: string | null
  resend_from: string | null
  max_records_per_user: number
  min_subdomain_length: number
}

type DbRow = {
  registration_enabled: number
  registration_mode: string
  invite_required: number | null
  email_whitelist_enabled: number
  email_whitelist_suffixes: string
  email_blacklist_enabled: number
  email_blacklist_suffixes: string
  github_min_account_age_days: number
  resend_enabled: number
  resend_api_key: string | null
  resend_from: string | null
  max_records_per_user: number | null
  min_subdomain_length: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  registration_enabled: true,
  registration_mode: 'email',
  invite_required: false,
  email_whitelist_enabled: false,
  email_whitelist_suffixes: [],
  email_blacklist_enabled: false,
  email_blacklist_suffixes: [],
  github_min_account_age_days: 0,
  resend_enabled: false,
  resend_api_key: null,
  resend_from: null,
  max_records_per_user: 5,
  min_subdomain_length: 0
}

export function isEmailAllowed(email: string, s: Settings): { ok: boolean; reason?: string } {
  const suffix = email.split('@')[1]?.toLowerCase() ?? ''
  if (!suffix) {
    return { ok: false, reason: '邮箱格式不正确' }
  }

  if (s.email_whitelist_enabled) {
    const list = s.email_whitelist_suffixes.map((x) => x.toLowerCase().trim()).filter(Boolean)
    if (list.length > 0 && !list.some((d) => suffix === d || suffix.endsWith('.' + d))) {
      return { ok: false, reason: '邮箱后缀不在白名单' }
    }
  }

  if (s.email_blacklist_enabled) {
    const list = s.email_blacklist_suffixes.map((x) => x.toLowerCase().trim()).filter(Boolean)
    if (list.some((d) => suffix === d || suffix.endsWith('.' + d))) {
      return { ok: false, reason: '邮箱后缀在黑名单中' }
    }
  }

  return { ok: true }
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare('SELECT * FROM settings WHERE id = ?')
    .bind('default')
    .first<DbRow>()

  if (!row) {
    return { ...DEFAULT_SETTINGS }
  }

  return {
    registration_enabled: !!row.registration_enabled,
    registration_mode: normalizeMode(row.registration_mode),
    invite_required: !!row.invite_required,
    email_whitelist_enabled: !!row.email_whitelist_enabled,
    email_whitelist_suffixes: safeParseArray(row.email_whitelist_suffixes),
    email_blacklist_enabled: !!row.email_blacklist_enabled,
    email_blacklist_suffixes: safeParseArray(row.email_blacklist_suffixes),
    github_min_account_age_days: row.github_min_account_age_days || 0,
    resend_enabled: !!row.resend_enabled,
    resend_api_key: row.resend_api_key,
    resend_from: row.resend_from,
    max_records_per_user: row.max_records_per_user ?? DEFAULT_SETTINGS.max_records_per_user,
    min_subdomain_length: row.min_subdomain_length ?? DEFAULT_SETTINGS.min_subdomain_length
  }
}

export async function updateSettings(
  db: D1Database,
  patch: Partial<Settings>
): Promise<Settings> {
  const current = await getSettings(db)
  const next: Settings = { ...current, ...patch }

  await db
    .prepare(
      `UPDATE settings SET
        registration_enabled = ?,
        registration_mode = ?,
        invite_required = ?,
        email_whitelist_enabled = ?,
        email_whitelist_suffixes = ?,
        email_blacklist_enabled = ?,
        email_blacklist_suffixes = ?,
        github_min_account_age_days = ?,
        resend_enabled = ?,
        resend_api_key = ?,
        resend_from = ?,
        max_records_per_user = ?,
        min_subdomain_length = ?
      WHERE id = ?`
    )
    .bind(
      next.registration_enabled ? 1 : 0,
      next.registration_mode,
      next.invite_required ? 1 : 0,
      next.email_whitelist_enabled ? 1 : 0,
      JSON.stringify(next.email_whitelist_suffixes),
      next.email_blacklist_enabled ? 1 : 0,
      JSON.stringify(next.email_blacklist_suffixes),
      next.github_min_account_age_days,
      next.resend_enabled ? 1 : 0,
      next.resend_api_key ?? null,
      next.resend_from ?? null,
      next.max_records_per_user,
      next.min_subdomain_length,
      'default'
    )
    .run()

  return next
}

function normalizeMode(m: string): 'email' | 'oauth' | 'both' {
  // legacy github mode -> oauth
  if (m === 'github' || m === 'oauth') return 'oauth'
  if (m === 'both') return 'both'
  return 'email'
}

function safeParseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // empty
  }
  return []
}

