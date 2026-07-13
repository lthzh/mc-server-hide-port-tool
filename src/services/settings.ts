import { getCachedSettings, invalidateSettingsCache } from './request-cache'

export type ResendAccount = {
  api_key: string
  from: string
}

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
  /** Ordered Resend accounts. First is primary; later ones are fallback. */
  resend_accounts: ResendAccount[]
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
  resend_accounts: [],
  max_records_per_user: 5,
  min_subdomain_length: 0
}

export function isEmailAllowed(email: string, s: Settings): { ok: boolean; reason?: string } {
  const suffix = email.split('@')[1]?.toLowerCase() ?? ''
  if (!suffix) {
    return { ok: false, reason: '???????' }
  }

  if (s.email_whitelist_enabled) {
    const list = s.email_whitelist_suffixes.map((x) => x.toLowerCase().trim()).filter(Boolean)
    if (list.length > 0 && !list.some((d) => suffix === d || suffix.endsWith('.' + d))) {
      return { ok: false, reason: '?????????' }
    }
  }

  if (s.email_blacklist_enabled) {
    const list = s.email_blacklist_suffixes.map((x) => x.toLowerCase().trim()).filter(Boolean)
    if (list.some((d) => suffix === d || suffix.endsWith('.' + d))) {
      return { ok: false, reason: '?????????' }
    }
  }

  return { ok: true }
}

export function parseResendAccounts(
  apiKeyRaw: string | null | undefined,
  fromRaw: string | null | undefined
): ResendAccount[] {
  const apiRaw = String(apiKeyRaw ?? '').trim()
  const fromRawStr = String(fromRaw ?? '').trim()
  if (!apiRaw && !fromRawStr) return []

  // Preferred: JSON array in resend_api_key, optional parallel from list in resend_from.
  if (apiRaw.startsWith('[')) {
    try {
      const parsed = JSON.parse(apiRaw) as unknown
      if (Array.isArray(parsed)) {
        const fromList = (() => {
          if (fromRawStr.startsWith('[')) {
            try {
              const f = JSON.parse(fromRawStr)
              return Array.isArray(f) ? f.map((x) => String(x ?? '').trim()) : []
            } catch {
              return []
            }
          }
          // single from applied to all, or csv
          if (fromRawStr.includes(',')) {
            return fromRawStr.split(',').map((x) => x.trim()).filter(Boolean)
          }
          return fromRawStr ? [fromRawStr] : []
        })()

        const accounts: ResendAccount[] = []
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i]
          if (typeof item === 'string') {
            const api_key = item.trim()
            const from = (fromList[i] || fromList[0] || '').trim()
            if (api_key && from) accounts.push({ api_key, from })
            continue
          }
          if (item && typeof item === 'object') {
            const rec = item as { api_key?: unknown; from?: unknown; apiKey?: unknown }
            const api_key = String(rec.api_key ?? rec.apiKey ?? '').trim()
            const from = String(rec.from ?? fromList[i] ?? fromList[0] ?? '').trim()
            if (api_key && from) accounts.push({ api_key, from })
          }
        }
        return accounts
      }
    } catch {
      // fall through to legacy parsing
    }
  }

  // Legacy single pair
  if (apiRaw && fromRawStr && !apiRaw.includes('\n') && !fromRawStr.includes('\n')) {
    return [{ api_key: apiRaw, from: fromRawStr }]
  }

  // Multiline / CSV pairs: one api key per line, one from per line
  const keys = apiRaw
    .split(/\r?\n|,/)
    .map((x) => x.trim())
    .filter(Boolean)
  const froms = fromRawStr
    .split(/\r?\n|,/)
    .map((x) => x.trim())
    .filter(Boolean)
  const accounts: ResendAccount[] = []
  const n = Math.max(keys.length, froms.length)
  for (let i = 0; i < n; i++) {
    const api_key = (keys[i] || keys[0] || '').trim()
    const from = (froms[i] || froms[0] || '').trim()
    if (api_key && from) accounts.push({ api_key, from })
  }
  // de-dupe exact pairs while preserving order
  const seen = new Set<string>()
  return accounts.filter((a) => {
    const k = `${a.api_key}||${a.from}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function serializeResendAccounts(accounts: ResendAccount[]): {
  resend_api_key: string | null
  resend_from: string | null
} {
  const cleaned = accounts
    .map((a) => ({
      api_key: String(a.api_key || '').trim(),
      from: String(a.from || '').trim()
    }))
    .filter((a) => a.api_key && a.from)
  if (cleaned.length === 0) {
    return { resend_api_key: null, resend_from: null }
  }
  return {
    resend_api_key: JSON.stringify(cleaned.map((a) => a.api_key)),
    resend_from: JSON.stringify(cleaned.map((a) => a.from))
  }
}

export function hasResendCredentials(s: Settings): boolean {
  return s.resend_accounts.length > 0
}

async function loadSettingsFromDb(db: D1Database): Promise<Settings> {
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
    resend_accounts: parseResendAccounts(row.resend_api_key, row.resend_from),
    max_records_per_user: row.max_records_per_user ?? DEFAULT_SETTINGS.max_records_per_user,
    min_subdomain_length: row.min_subdomain_length ?? DEFAULT_SETTINGS.min_subdomain_length
  }
}

export async function getSettings(db: D1Database): Promise<Settings> {
  return getCachedSettings(db, () => loadSettingsFromDb(db))
}

export async function updateSettings(
  db: D1Database,
  patch: Partial<Settings>
): Promise<Settings> {
  const current = await getSettings(db)
  const next: Settings = { ...current, ...patch }
  const serialized = serializeResendAccounts(next.resend_accounts)

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
      serialized.resend_api_key,
      serialized.resend_from,
      next.max_records_per_user,
      next.min_subdomain_length,
      'default'
    )
    .run()

  invalidateSettingsCache(db)
  return next
}

function normalizeMode(m: string): 'email' | 'oauth' | 'both' {
  if (m === 'oauth') return 'oauth'
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
