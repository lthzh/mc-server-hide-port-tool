import { getSettings } from './settings'
import {
  getGitHubPrimaryEmail,
  getGitHubUser,
  meetsAgeRequirement,
  throwGitHubAgeRejected
} from './github'

export type OAuthProviderRow = {
  id: string
  provider_id: string
  name: string
  client_id: string
  client_secret: string
  discovery_url: string | null
  authorization_url: string | null
  token_url: string | null
  user_info_url: string | null
  scopes: string
  pkce: number
  enabled: number
  sort_order: number
  icon_url: string | null
  created_at: number
  updated_at: number
}

export type OAuthProviderPublic = {
  provider_id: string
  name: string
  icon_url: string | null
  sort_order: number
}

export type OAuthProviderInput = {
  provider_id: string
  name: string
  client_id: string
  client_secret: string
  discovery_url?: string
  authorization_url?: string
  token_url?: string
  user_info_url?: string
  scopes?: string
  pkce?: boolean
  enabled?: boolean
  sort_order?: number
  icon_url?: string
}

export type OAuthTemplate = {
  id: string
  name: string
  provider_id: string
  discovery_url?: string
  authorization_url?: string
  token_url?: string
  user_info_url?: string
  scopes: string
  pkce: boolean
  icon_url?: string
  notes?: string
}

const RESERVED_PROVIDER_IDS = new Set(['credential'])

export const OAUTH_TEMPLATES: OAuthTemplate[] = [
  {
    id: 'github',
    name: 'GitHub',
    provider_id: 'github',
    authorization_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    user_info_url: 'https://api.github.com/user',
    scopes: 'read:user,user:email',
    pkce: false,
    icon_url: 'https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/github.svg',
    notes: 'Callback: BETTER_AUTH_URL/api/auth/oauth2/callback/github'
  },
  {
    id: 'google',
    name: 'Google',
    provider_id: 'google',
    discovery_url: 'https://accounts.google.com/.well-known/openid-configuration',
    scopes: 'openid,profile,email',
    pkce: true,
    icon_url: 'https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/google.svg'
  },
  {
    id: 'microsoft',
    name: 'Microsoft Entra ID',
    provider_id: 'microsoft',
    discovery_url:
      'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    scopes: 'openid,profile,email,offline_access',
    pkce: true,
    icon_url: 'https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/microsoft.svg'
  },
  {
    id: 'discord',
    name: 'Discord',
    provider_id: 'discord',
    authorization_url: 'https://discord.com/api/oauth2/authorize',
    token_url: 'https://discord.com/api/oauth2/token',
    user_info_url: 'https://discord.com/api/users/@me',
    scopes: 'identify,email',
    pkce: true,
    icon_url: 'https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/discord.svg'
  },
  {
    id: 'linuxdo',
    name: 'Linux.do',
    provider_id: 'linuxdo',
    authorization_url: 'https://connect.linux.do/oauth2/authorize',
    token_url: 'https://connect.linux.do/oauth2/token',
    user_info_url: 'https://connect.linux.do/api/user',
    scopes: 'openid,profile,email',
    pkce: true
  },
  {
    id: 'oidc',
    name: 'Generic OIDC',
    provider_id: 'oidc',
    discovery_url: '',
    scopes: 'openid,profile,email',
    pkce: true,
    notes: 'Fill discovery_url or authorization/token/userinfo URLs'
  }
]

export function getOAuthTemplate(id: string): OAuthTemplate | null {
  return OAUTH_TEMPLATES.find((t) => t.id === id) ?? null
}

function parseScopes(scopes: string | null | undefined): string[] {
  return String(scopes ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeOptionalUrl(raw: string | undefined | null): string | null {
  const v = String(raw ?? '').trim()
  return v ? v : null
}

function normalizeIconUrl(raw: string | undefined | null): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return null
  return v
}

export function validateOAuthProviderInput(
  input: OAuthProviderInput,
  opts?: { requireSecret?: boolean }
):
  | {
      ok: true
      value: {
        provider_id: string
        name: string
        client_id: string
        client_secret: string
        discovery_url: string | null
        authorization_url: string | null
        token_url: string | null
        user_info_url: string | null
        scopes: string
        pkce: boolean
        enabled: boolean
        sort_order: number
        icon_url: string | null
      }
    }
  | { ok: false; message: string } {
  const provider_id = String(input.provider_id ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
  const name = String(input.name ?? '').trim()
  const client_id = String(input.client_id ?? '').trim()
  const client_secret = String(input.client_secret ?? '').trim()
  const discovery_url = normalizeOptionalUrl(input.discovery_url)
  const authorization_url = normalizeOptionalUrl(input.authorization_url)
  const token_url = normalizeOptionalUrl(input.token_url)
  const user_info_url = normalizeOptionalUrl(input.user_info_url)
  const icon_url = normalizeIconUrl(input.icon_url)
  const scopes = String(input.scopes ?? 'openid,profile,email').trim() || 'openid,profile,email'
  const pkce = input.pkce !== false
  const enabled = input.enabled !== false
  const sort_order = Number.isFinite(Number(input.sort_order)) ? Math.floor(Number(input.sort_order)) : 0

  if (!provider_id) return { ok: false, message: '提供商 ID 无效（仅支持字母数字、下划线、中划线）' }
  if (RESERVED_PROVIDER_IDS.has(provider_id)) {
    return { ok: false, message: 'provider_id 不能为 credential' }
  }
  if (!name) return { ok: false, message: '请填写显示名称' }
  if (!client_id) return { ok: false, message: '请填写 client_id' }
  if (opts?.requireSecret !== false && !client_secret) {
    return { ok: false, message: '请填写 client_secret' }
  }
  if (input.icon_url && String(input.icon_url).trim() && !icon_url) {
    return { ok: false, message: '图标 URL 需以 http:// 或 https:// 开头' }
  }
  if (!discovery_url && !(authorization_url && token_url)) {
    return {
      ok: false,
      message:
        '请填写 Discovery URL，或同时填写 Authorization URL 与 Token URL'
    }
  }

  return {
    ok: true,
    value: {
      provider_id,
      name,
      client_id,
      client_secret,
      discovery_url,
      authorization_url,
      token_url,
      user_info_url,
      scopes,
      pkce,
      enabled,
      sort_order,
      icon_url
    }
  }
}

export async function listOAuthProviders(db: D1Database): Promise<OAuthProviderRow[]> {
  const result = await db
    .prepare('SELECT * FROM oauth_provider ORDER BY sort_order ASC, created_at ASC')
    .all<OAuthProviderRow>()
  return result.results ?? []
}

export async function listEnabledOAuthProviders(db: D1Database): Promise<OAuthProviderRow[]> {
  const result = await db
    .prepare('SELECT * FROM oauth_provider WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC')
    .all<OAuthProviderRow>()
  return result.results ?? []
}

export async function listPublicOAuthProviders(db: D1Database): Promise<OAuthProviderPublic[]> {
  const rows = await listEnabledOAuthProviders(db)
  return rows.map((r) => ({
    provider_id: r.provider_id,
    name: r.name,
    icon_url: r.icon_url ?? null,
    sort_order: r.sort_order
  }))
}

export async function findOAuthProviderById(db: D1Database, id: string): Promise<OAuthProviderRow | null> {
  return await db.prepare('SELECT * FROM oauth_provider WHERE id = ?').bind(id).first<OAuthProviderRow>()
}

export async function findOAuthProviderByProviderId(
  db: D1Database,
  providerId: string
): Promise<OAuthProviderRow | null> {
  return await db
    .prepare('SELECT * FROM oauth_provider WHERE provider_id = ?')
    .bind(providerId)
    .first<OAuthProviderRow>()
}

export async function createOAuthProvider(
  db: D1Database,
  input: OAuthProviderInput
): Promise<{ ok: true; provider: OAuthProviderRow } | { ok: false; message: string }> {
  const validated = validateOAuthProviderInput(input, { requireSecret: true })
  if (!validated.ok) return validated

  const existing = await findOAuthProviderByProviderId(db, validated.value.provider_id)
  if (existing) return { ok: false, message: 'provider_id 已存在' }

  const now = Date.now()
  const id = crypto.randomUUID()
  const row: OAuthProviderRow = {
    id,
    provider_id: validated.value.provider_id,
    name: validated.value.name,
    client_id: validated.value.client_id,
    client_secret: validated.value.client_secret,
    discovery_url: validated.value.discovery_url,
    authorization_url: validated.value.authorization_url,
    token_url: validated.value.token_url,
    user_info_url: validated.value.user_info_url,
    scopes: validated.value.scopes,
    pkce: validated.value.pkce ? 1 : 0,
    enabled: validated.value.enabled ? 1 : 0,
    sort_order: validated.value.sort_order,
    icon_url: validated.value.icon_url,
    created_at: now,
    updated_at: now
  }

  await db
    .prepare(
      `INSERT INTO oauth_provider
        (id, provider_id, name, client_id, client_secret, discovery_url, authorization_url, token_url, user_info_url, scopes, pkce, enabled, sort_order, icon_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.provider_id,
      row.name,
      row.client_id,
      row.client_secret,
      row.discovery_url,
      row.authorization_url,
      row.token_url,
      row.user_info_url,
      row.scopes,
      row.pkce,
      row.enabled,
      row.sort_order,
      row.icon_url,
      row.created_at,
      row.updated_at
    )
    .run()

  return { ok: true, provider: row }
}

export async function updateOAuthProvider(
  db: D1Database,
  id: string,
  input: OAuthProviderInput
): Promise<{ ok: true; provider: OAuthProviderRow } | { ok: false; message: string }> {
  const current = await findOAuthProviderById(db, id)
  if (!current) return { ok: false, message: 'OAuth 应用不存在' }

  const secret = input.client_secret.trim() || current.client_secret
  const validated = validateOAuthProviderInput(
    { ...input, client_secret: secret },
    { requireSecret: true }
  )
  if (!validated.ok) return validated

  const conflict = await findOAuthProviderByProviderId(db, validated.value.provider_id)
  if (conflict && conflict.id !== id) {
    return { ok: false, message: 'provider_id 已存在' }
  }

  const now = Date.now()
  await db
    .prepare(
      `UPDATE oauth_provider SET
        provider_id = ?,
        name = ?,
        client_id = ?,
        client_secret = ?,
        discovery_url = ?,
        authorization_url = ?,
        token_url = ?,
        user_info_url = ?,
        scopes = ?,
        pkce = ?,
        enabled = ?,
        sort_order = ?,
        icon_url = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      validated.value.provider_id,
      validated.value.name,
      validated.value.client_id,
      validated.value.client_secret,
      validated.value.discovery_url,
      validated.value.authorization_url,
      validated.value.token_url,
      validated.value.user_info_url,
      validated.value.scopes,
      validated.value.pkce ? 1 : 0,
      validated.value.enabled ? 1 : 0,
      validated.value.sort_order,
      validated.value.icon_url,
      now,
      id
    )
    .run()

  const updated = await findOAuthProviderById(db, id)
  if (!updated) return { ok: false, message: '更新失败' }
  return { ok: true, provider: updated }
}

export async function deleteOAuthProvider(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM oauth_provider WHERE id = ?').bind(id).run()
}

export async function setOAuthProviderEnabled(
  db: D1Database,
  id: string,
  enabled: boolean
): Promise<void> {
  await db
    .prepare('UPDATE oauth_provider SET enabled = ?, updated_at = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, Date.now(), id)
    .run()
}

export function toGenericOAuthConfig(row: OAuthProviderRow, db: D1Database) {
  const base = {
    providerId: row.provider_id,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    discoveryUrl: row.discovery_url || undefined,
    authorizationUrl: row.authorization_url || undefined,
    tokenUrl: row.token_url || undefined,
    userInfoUrl: row.user_info_url || undefined,
    scopes: parseScopes(row.scopes),
    pkce: !!row.pkce
  }

  if (row.provider_id === 'github') {
    return {
      ...base,
      async getUserInfo(tokens: { accessToken?: string | null }) {
        const accessToken = tokens.accessToken
        if (!accessToken) return null

        const profile = await getGitHubUser(accessToken)
        if (!profile?.id) return null

        const accountId = String(profile.id)
        let email = profile.email || null
        if (!email) {
          email = await getGitHubPrimaryEmail(accessToken)
        }
        if (!email) return null

        // Only enforce age for brand-new local accounts. Existing linked users may still log in.
        const existingAccount = await db
          .prepare(
            "SELECT id FROM account WHERE providerId = 'github' AND accountId = ? LIMIT 1"
          )
          .bind(accountId)
          .first<{ id: string }>()
        const existingUser = existingAccount
          ? null
          : await db
              .prepare('SELECT id FROM user WHERE email = ? LIMIT 1')
              .bind(email.toLowerCase())
              .first<{ id: string }>()

        if (!existingAccount && !existingUser) {
          const settings = await getSettings(db)
          if (
            settings.github_min_account_age_days > 0 &&
            !meetsAgeRequirement(profile.created_at, settings.github_min_account_age_days)
          ) {
            // Throwing aborts OAuth callback before better-auth creates user/session.
            throwGitHubAgeRejected(settings.github_min_account_age_days)
          }
        }

        return {
          id: accountId,
          name: profile.name || profile.login || email,
          email,
          image: profile.avatar_url || undefined,
          emailVerified: true
        }
      }
    }
  }

  return base
}
