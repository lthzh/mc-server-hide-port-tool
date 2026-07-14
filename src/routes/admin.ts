import type { Hono } from 'hono'
import { createAuth, isSuperAdminUser, requireAdmin } from '../auth'
import { getSettings, updateSettings, type Settings } from '../services/settings'
import {
  deleteUserCascade,
  findRecordById,
  findUserById,
  hasUnlimitedDnsLimits,
  isSuperAdmin,
  listAllUsers,
  listRecordsByUser,
  searchUsers,
  type UserSearchRole,
  setUserRecordLimit,
  setUserRole
} from '../services/dns-records'
import {
  createInviteCode,
  revokeInviteCode
} from '../services/invite-codes'
import { sendTestEmail } from '../services/mailer'
import {
  createOAuthProvider,
  deleteOAuthProvider,
  setOAuthProviderEnabled,
  updateOAuthProvider
} from '../services/oauth-providers'
import { deleteRecordAndCloudflare, type Bindings } from '../services/cloudflare-dns'
import { splitCsv, withoutSetCookieHeaders } from '../lib/http'
import {
  apiErr,
  apiOk,
  readJsonBody,
  requireJsonMutation
} from '../lib/api'
import { maskUsersForAdmin } from '../lib/privacy'

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

function buildResendAccounts(
  body: Record<string, unknown>,
  current: Settings
): { api_key: string; from: string }[] {
  const primaryKeyRaw = String(body.resend_api_key ?? '').trim()
  const primaryFromRaw = String(body.resend_from ?? '').trim()
  const accountFromsRaw = String(body.resend_account_froms ?? '').trim()
  const accountKeysRaw = String(body.resend_account_keys ?? '').trim()

  const fromLines = (accountFromsRaw || primaryFromRaw)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  const keyLines = accountKeysRaw
    .split(/\r?\n/)
    .map((x) => x.trim())

  const froms = fromLines.length > 0 ? fromLines : (primaryFromRaw ? [primaryFromRaw] : [])
  if (primaryFromRaw) {
    if (froms.length === 0) froms.push(primaryFromRaw)
    else froms[0] = primaryFromRaw
  }
  if (primaryKeyRaw) {
    if (keyLines.length === 0) keyLines.push(primaryKeyRaw)
    else keyLines[0] = primaryKeyRaw
  }

  const prev = current.resend_accounts || []
  const prevByFrom = new Map(prev.map((a) => [a.from, a.api_key] as const))
  const nextAccounts = [] as { api_key: string; from: string }[]
  for (let i = 0; i < froms.length; i++) {
    const from = froms[i]!
    const typedKey = (keyLines[i] || '').trim()
    const isKeep = !typedKey || typedKey === '__KEEP__'
    const api_key = isKeep
      ? (prevByFrom.get(from) || prev[i]?.api_key || '')
      : typedKey
    if (api_key && from) nextAccounts.push({ api_key, from })
  }
  return nextAccounts
}

export function registerAdminRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/admin/settings', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const body = await readJsonBody(c)
    const current = await getSettings(c.env.DB)
    const mode = String(body.registration_mode ?? 'email')
    const modeNorm: 'email' | 'oauth' | 'both' =
      mode === 'oauth' ? 'oauth' : mode === 'both' ? 'both' : 'email'

    const whitelistSuffixesRaw = String(body.email_whitelist_suffixes ?? '').trim()
    const blacklistSuffixesRaw = String(body.email_blacklist_suffixes ?? '').trim()
    const resend_accounts = buildResendAccounts(body, current)

    const patch: Partial<Settings> = {
      registration_enabled: asBool(body.registration_enabled),
      registration_mode: modeNorm,
      invite_required: asBool(body.invite_required),
      email_whitelist_enabled: asBool(body.email_whitelist_enabled),
      email_whitelist_suffixes: splitCsv(whitelistSuffixesRaw),
      email_blacklist_enabled: asBool(body.email_blacklist_enabled),
      email_blacklist_suffixes: splitCsv(blacklistSuffixesRaw),
      github_min_account_age_days: Math.max(0, Number(body.github_min_account_age_days ?? 0) || 0),
      resend_enabled: asBool(body.resend_enabled),
      resend_accounts,
      max_records_per_user: Math.max(0, Number(body.max_records_per_user ?? 0) || 0),
      min_subdomain_length: Math.max(0, Number(body.min_subdomain_length ?? 0) || 0)
    }

    await updateSettings(c.env.DB, patch)
    return apiOk(c, undefined, { message: "设置已保存" })
  })


  app.get('/api/admin/users', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const q = String(c.req.query('q') ?? '').trim()
    const roleRaw = String(c.req.query('role') ?? 'all').trim().toLowerCase()
    const role: UserSearchRole =
      roleRaw === 'user' || roleRaw === 'admin' || roleRaw === 'super' ? roleRaw : 'all'

    // Search plaintext in DB, then force-mask email before returning to admin UI.
    const users = await searchUsers(c.env.DB, { q, role })
    return apiOk(c, {
      users: maskUsersForAdmin(users),
      query: { q, role },
      total: users.length
    })
  })

  app.post('/api/admin/users/:id/role', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)
    if (!isSuperAdminUser(admin)) return apiErr(c, "仅超级管理员可修改角色", 403)

    const id = c.req.param('id')
    if (id === admin.id) return apiErr(c, "不能修改自己的角色")
    if (await isSuperAdmin(c.env.DB, id)) return apiErr(c, "不能修改超级管理员角色")

    const body = await readJsonBody(c)
    const roleFromBody = String(body.role ?? '')
    if (roleFromBody !== 'admin' && roleFromBody !== 'user') {
      return apiErr(c, "无效角色")
    }
    await setUserRole(c.env.DB, id, roleFromBody)
    return apiOk(c, undefined, { message: "角色已更新" })
  })

  app.post('/api/admin/users/:id/delete', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    if (id === admin.id) return apiErr(c, "不能删除自己")
    const target = await findUserById(c.env.DB, id)
    if (!target) return apiErr(c, "用户不存在", 404)
    if (target.role === 'admin' && !isSuperAdminUser(admin)) {
      return apiErr(c, "仅超级管理员可删除管理员", 403)
    }
    if (await isSuperAdmin(c.env.DB, id)) return apiErr(c, "不能删除超级管理员", 403)

    const records = await listRecordsByUser(c.env.DB, id)
    for (const r of records) {
      await deleteRecordAndCloudflare(c.env, r)
    }
    await deleteUserCascade(c.env.DB, id)
    return apiOk(c, undefined, { message: "用户已删除" })
  })

  app.post('/api/admin/users/:id/limit', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    const target = await findUserById(c.env.DB, id)
    if (!target || hasUnlimitedDnsLimits(target)) {
      return apiErr(c, "该用户记录上限不可修改")
    }

    const body = await readJsonBody(c)
    const raw = String(body.record_limit ?? '').trim()
    let limit: number | null = null
    if (raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return apiErr(c, "记录上限无效")
      limit = Math.floor(n)
    }
    await setUserRecordLimit(c.env.DB, id, limit)
    return apiOk(c, undefined, { message: "记录上限已更新" })
  })

  app.post('/api/admin/users/create', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const body = await readJsonBody(c)
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    const role = isSuperAdminUser(admin) && String(body.role ?? 'user') === 'admin' ? 'admin' : 'user'

    if (!name || !email || password.length < 8) {
      return apiErr(c, "请填写完整信息，密码至少 8 位")
    }

    const auth = await createAuth(c.env)
    try {
      const signUpRes = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      withoutSetCookieHeaders(signUpRes.headers)
      if (!signUpRes.ok) {
        const data = await signUpRes.json().catch(() => ({}))
        const msg = (data as { message?: string }).message || "创建用户失败"
        return apiErr(c, msg, signUpRes.status)
      }
      const listRes = await listAllUsers(c.env.DB)
      const newUser = listRes.find((u) => u.email === email)
      if (newUser && role === 'admin') {
        await setUserRole(c.env.DB, newUser.id, 'admin')
      }
      return apiOk(c, undefined, { message: "用户已创建" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "创建用户失败"
      return apiErr(c, msg, 500)
    }
  })

  app.post('/api/admin/dns/:id/delete', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    const record = await findRecordById(c.env.DB, id)
    if (record) {
      await deleteRecordAndCloudflare(c.env, record)
    }
    return apiOk(c, undefined, { message: "DNS 记录已删除" })
  })

  app.post('/api/admin/invites/create', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const settings = await getSettings(c.env.DB)
    if (!settings.invite_required) return apiErr(c, "请先开启邀请码注册")
    try {
      const created = await createInviteCode(c.env.DB, admin.id)
      return apiOk(c, { code: created.code }, { message: "已创建邀请码 " + created.code })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "创建邀请码失败"
      return apiErr(c, msg, 500)
    }
  })

  app.post('/api/admin/invites/:id/revoke', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    const result = await revokeInviteCode(c.env.DB, id)
    if (!result.ok) return apiErr(c, result.message)
    return apiOk(c, undefined, { message: "邀请码已作废" })
  })

  app.post('/api/admin/oauth/create', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const body = await readJsonBody(c)
    const result = await createOAuthProvider(c.env.DB, {
      provider_id: String(body.provider_id ?? ''),
      name: String(body.name ?? ''),
      client_id: String(body.client_id ?? ''),
      client_secret: String(body.client_secret ?? ''),
      discovery_url: String(body.discovery_url ?? ''),
      authorization_url: String(body.authorization_url ?? ''),
      token_url: String(body.token_url ?? ''),
      user_info_url: String(body.user_info_url ?? ''),
      scopes: String(body.scopes ?? 'openid,profile,email'),
      pkce: asBool(body.pkce),
      enabled: asBool(body.enabled),
      sort_order: Number(body.sort_order ?? 0),
      icon_url: String(body.icon_url ?? '')
    })
    if (!result.ok) return apiErr(c, result.message)
    return apiOk(c, { provider: result.provider }, { message: "已添加 OAuth 应用 " + result.provider.name })
  })

  app.post('/api/admin/oauth/:id/update', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    const body = await readJsonBody(c)
    const result = await updateOAuthProvider(c.env.DB, id, {
      provider_id: String(body.provider_id ?? ''),
      name: String(body.name ?? ''),
      client_id: String(body.client_id ?? ''),
      client_secret: String(body.client_secret ?? ''),
      discovery_url: String(body.discovery_url ?? ''),
      authorization_url: String(body.authorization_url ?? ''),
      token_url: String(body.token_url ?? ''),
      user_info_url: String(body.user_info_url ?? ''),
      scopes: String(body.scopes ?? 'openid,profile,email'),
      pkce: asBool(body.pkce),
      enabled: asBool(body.enabled),
      sort_order: Number(body.sort_order ?? 0),
      icon_url: String(body.icon_url ?? '')
    })
    if (!result.ok) return apiErr(c, result.message)
    return apiOk(c, undefined, { message: "已更新" })
  })

  app.post('/api/admin/oauth/:id/toggle', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    const body = await readJsonBody(c)
    const enabled = asBool(body.enabled)
    await setOAuthProviderEnabled(c.env.DB, id, enabled)
    return apiOk(c, undefined, { message: enabled ? "已启用" : "已停用" })
  })

  app.post('/api/admin/oauth/:id/delete', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const id = c.req.param('id')
    await deleteOAuthProvider(c.env.DB, id)
    return apiOk(c, undefined, { message: "已删除" })
  })

  app.post('/api/admin/mail/test', async (c) => {
    const denied = await requireJsonMutation(c)
    if (denied) return denied
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return apiErr(c, "无权限", 403)

    const body = await readJsonBody(c)
    const toEmail = String(body.to_email ?? '').trim()
    if (!toEmail || !toEmail.includes('@')) {
      return apiErr(c, "请输入有效的接收邮箱")
    }

    try {
      const result = await sendTestEmail(c.env, toEmail)
      if (!result.ok) return apiErr(c, result.message || "测试邮件发送失败", 500)
      return apiOk(c, undefined, { message: "测试邮件已提交发送：" + toEmail })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "测试邮件发送失败"
      return apiErr(c, msg, 500)
    }
  })
}
