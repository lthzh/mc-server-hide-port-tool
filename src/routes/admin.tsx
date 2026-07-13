import type { Hono } from 'hono'
import { createAuth, isSuperAdminUser, requireAdmin } from '../auth'
import { Layout } from '../views/Layout'
import { AdminView } from '../views/AdminView'
import { getSettings, updateSettings, type Settings, parseResendAccounts } from '../services/settings'
import {
  deleteUserCascade,
  findRecordById,
  findUserById,
  hasUnlimitedDnsLimits,
  isSuperAdmin,
  listAllRecords,
  listAllUsers,
  listRecordsByUser,
  setUserRecordLimit,
  setUserRole
} from '../services/dns-records'
import {
  createInviteCode,
  listInviteCodes,
  revokeInviteCode
} from '../services/invite-codes'
import { sendTestEmail } from '../services/mailer'
import {
  createOAuthProvider,
  deleteOAuthProvider,
  listOAuthProviders,
  OAUTH_TEMPLATES,
  setOAuthProviderEnabled,
  updateOAuthProvider
} from '../services/oauth-providers'
import { deleteRecordAndCloudflare, type Bindings } from '../services/cloudflare-dns'
import { splitCsv, withoutSetCookieHeaders } from '../lib/http'
import { getRequestCsrf, requireMutationCsrf, withCsrfCookie } from '../lib/csrf'

type AdminTab = 'settings' | 'oauth' | 'invites' | 'users' | 'dns'

function parseAdminTab(raw: string | undefined | null): AdminTab {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'oauth' || v === 'invites' || v === 'users' || v === 'dns' || v === 'settings') return v
  return 'settings'
}

function adminPath(tab: AdminTab = 'settings', query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams()
  if (tab && tab !== 'settings') params.set('tab', tab)
  for (const [k, v] of Object.entries(query)) {
    if (v) params.set(k, v)
  }
  const qs = params.toString()
  return qs ? `/admin?${qs}` : '/admin'
}

export function registerAdminRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/admin', async (c) => {
    const user = await requireAdmin(c.env, c.req.raw.headers)
    if (!user) return c.redirect('/')
    const tabFromQuery = c.req.query('tab')
    const inferredTab =
      tabFromQuery
        ? parseAdminTab(tabFromQuery)
        : c.req.query('create_error')
          ? 'users'
          : c.req.query('invite_error') || c.req.query('invite_info')
            ? 'invites'
            : c.req.query('oauth_error') || c.req.query('oauth_info')
              ? 'oauth'
              : c.req.query('mail_error') || c.req.query('mail_info')
                ? 'settings'
                : 'settings'
    const activeTab = inferredTab
    const [users, records, settings, inviteCodes, oauthProviders] = await Promise.all([
      listAllUsers(c.env.DB),
      listAllRecords(c.env.DB),
      getSettings(c.env.DB),
      listInviteCodes(c.env.DB),
      listOAuthProviders(c.env.DB)
    ])
    const csrf = getRequestCsrf(c)
    const html = c.html(
      <Layout title="管理后台">
        <AdminView
          users={users}
          records={records}
          settings={settings}
          inviteCodes={inviteCodes}
          oauthProviders={oauthProviders}
          oauthTemplates={OAUTH_TEMPLATES}
          currentUserId={user.id}
          currentUserSuperAdmin={isSuperAdminUser(user)}
          activeTab={activeTab}
          csrfToken={csrf.token}
          createError={c.req.query('create_error') ?? undefined}
          inviteError={c.req.query('invite_error') ?? undefined}
          inviteInfo={c.req.query('invite_info') ?? undefined}
          oauthError={c.req.query('oauth_error') ?? undefined}
          oauthInfo={c.req.query('oauth_info') ?? undefined}
          mailError={c.req.query('mail_error') ?? undefined}
          mailInfo={c.req.query('mail_info') ?? undefined}
        />
      </Layout>
    )
    return withCsrfCookie(await html, csrf.setCookie)
  })

  app.post('/admin/settings', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const current = await getSettings(c.env.DB)

    const mode = String(form.get('registration_mode') ?? 'email')
    const modeNorm: 'email' | 'oauth' | 'both' =
      mode === 'oauth' ? 'oauth' : mode === 'both' ? 'both' : 'email'

    const whitelistSuffixesRaw = String(form.get('email_whitelist_suffixes') ?? '').trim()
    const blacklistSuffixesRaw = String(form.get('email_blacklist_suffixes') ?? '').trim()
    const primaryKeyRaw = String(form.get('resend_api_key') ?? '').trim()
    const primaryFromRaw = String(form.get('resend_from') ?? '').trim()
    const accountFromsRaw = String(form.get('resend_account_froms') ?? '').trim()
    const accountKeysRaw = String(form.get('resend_account_keys') ?? '').trim()

    // Build ordered accounts from modal list when present; otherwise fall back to primary fields.
    const fromLines = (accountFromsRaw || primaryFromRaw)
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    const keyLines = accountKeysRaw
      .split(/\r?\n/)
      .map((x) => x.trim())

    const froms = fromLines.length > 0 ? fromLines : (primaryFromRaw ? [primaryFromRaw] : [])
    // Primary form fields always represent the first account.
    if (primaryFromRaw) {
      if (froms.length === 0) froms.push(primaryFromRaw)
      else froms[0] = primaryFromRaw
    }
    // Primary key field overrides first key line when provided.
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
    // If user cleared all froms, clear accounts.
    // If they only left primary key blank and from blank intentionally, nextAccounts may be empty.
    const resend_accounts = nextAccounts

    const patch: Partial<Settings> = {
      registration_enabled: form.get('registration_enabled') === 'on',
      registration_mode: modeNorm,
      invite_required: form.get('invite_required') === 'on',
      email_whitelist_enabled: form.get('email_whitelist_enabled') === 'on',
      email_whitelist_suffixes: splitCsv(whitelistSuffixesRaw),
      email_blacklist_enabled: form.get('email_blacklist_enabled') === 'on',
      email_blacklist_suffixes: splitCsv(blacklistSuffixesRaw),
      github_min_account_age_days: Math.max(0, Number(form.get('github_min_account_age_days') ?? 0) || 0),
      resend_enabled: form.get('resend_enabled') === 'on',
      resend_accounts,
      max_records_per_user: Math.max(0, Number(form.get('max_records_per_user') ?? 0) || 0),
      min_subdomain_length: Math.max(0, Number(form.get('min_subdomain_length') ?? 0) || 0)
    }

    await updateSettings(c.env.DB, patch)
    return c.redirect(adminPath('settings'))
  })

  app.post('/admin/users/:id/role', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    if (!isSuperAdminUser(admin)) return c.redirect(adminPath('users'))
    const id = c.req.param('id')
    if (id === admin.id) return c.redirect(adminPath('users'))
    const targetSuper = await isSuperAdmin(c.env.DB, id)
    if (targetSuper) return c.redirect(adminPath('users'))
    const roleFromForm = String(form.get('role') ?? '')
    if (roleFromForm === 'admin' || roleFromForm === 'user') {
      await setUserRole(c.env.DB, id, roleFromForm)
    }
    return c.redirect(adminPath('users'))
  })

  app.post('/admin/users/:id/delete', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    if (id === admin.id) return c.redirect(adminPath('users'))
    const target = await findUserById(c.env.DB, id)
    if (!target) return c.redirect(adminPath('users'))
    if (target.role === 'admin' && !isSuperAdminUser(admin)) return c.redirect(adminPath('users'))
    const targetSuper = await isSuperAdmin(c.env.DB, id)
    if (targetSuper) return c.redirect(adminPath('users'))
    const records = await listRecordsByUser(c.env.DB, id)
    for (const r of records) {
      await deleteRecordAndCloudflare(c.env, r)
    }
    await deleteUserCascade(c.env.DB, id)
    return c.redirect(adminPath('users'))
  })

  app.post('/admin/users/:id/limit', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const target = await findUserById(c.env.DB, id)
    if (!target || hasUnlimitedDnsLimits(target)) return c.redirect(adminPath('users'))
    const raw = String(form.get('record_limit') ?? '').trim()
    let limit: number | null = null
    if (raw !== '') {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= 0) {
        limit = Math.floor(n)
      } else {
        return c.redirect(adminPath('users'))
      }
    }
    await setUserRecordLimit(c.env.DB, id, limit)
    return c.redirect(adminPath('users'))
  })

  app.post('/admin/users/create', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const role = isSuperAdminUser(admin) && String(form.get('role') ?? 'user') === 'admin' ? 'admin' : 'user'

    if (!name || !email || password.length < 8) {
      return c.redirect(adminPath('users', { create_error: '请填写完整信息，密码至少 8 位' }))
    }

    const auth = await createAuth(c.env)
    try {
      // asResponse + strip Set-Cookie so auto-login cannot replace the admin session.
      const signUpRes = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      // Explicitly drop any session cookies from nested better-auth response.
      withoutSetCookieHeaders(signUpRes.headers)
      if (!signUpRes.ok) {
        const data = await signUpRes.json().catch(() => ({}))
        const msg = (data as { message?: string }).message || '创建用户失败'
        return c.redirect(adminPath('users', { create_error: msg }))
      }
      const listRes = await listAllUsers(c.env.DB)
      const newUser = listRes.find((u) => u.email === email)
      if (newUser && role === 'admin') {
        await setUserRole(c.env.DB, newUser.id, 'admin')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建用户失败'
      return c.redirect(adminPath('users', { create_error: msg }))
    }
    return c.redirect(adminPath('users'))
  })

  app.post('/admin/dns/:id/delete', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const record = await findRecordById(c.env.DB, id)
    if (record) {
      await deleteRecordAndCloudflare(c.env, record)
    }
    return c.redirect(adminPath('dns'))
  })

  app.post('/admin/invites/create', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const settings = await getSettings(c.env.DB)
    if (!settings.invite_required) {
      return c.redirect(adminPath('invites', { invite_error: '请先开启邀请码注册' }))
    }
    try {
      const created = await createInviteCode(c.env.DB, admin.id)
      return c.redirect(adminPath('invites', { invite_info: `已创建邀请码 ${created.code}` }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建邀请码失败'
      return c.redirect(adminPath('invites', { invite_error: msg }))
    }
  })

  app.post('/admin/invites/:id/revoke', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const result = await revokeInviteCode(c.env.DB, id)
    if (!result.ok) {
      return c.redirect(adminPath('invites', { invite_error: result.message }))
    }
    return c.redirect(adminPath('invites', { invite_info: '邀请码已作废' }))
  })

  app.post('/admin/oauth/create', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const result = await createOAuthProvider(c.env.DB, {
      provider_id: String(form.get('provider_id') ?? ''),
      name: String(form.get('name') ?? ''),
      client_id: String(form.get('client_id') ?? ''),
      client_secret: String(form.get('client_secret') ?? ''),
      discovery_url: String(form.get('discovery_url') ?? ''),
      authorization_url: String(form.get('authorization_url') ?? ''),
      token_url: String(form.get('token_url') ?? ''),
      user_info_url: String(form.get('user_info_url') ?? ''),
      scopes: String(form.get('scopes') ?? 'openid,profile,email'),
      pkce: form.get('pkce') === 'on',
      enabled: form.get('enabled') === 'on',
      sort_order: Number(form.get('sort_order') ?? 0),
      icon_url: String(form.get('icon_url') ?? '')
    })
    if (!result.ok) {
      return c.redirect(adminPath('oauth', { oauth_error: result.message }))
    }
    return c.redirect(adminPath('oauth', { oauth_info: `已添加 OAuth 应用 ${result.provider.name}` }))
  })

  app.post('/admin/oauth/:id/update', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const result = await updateOAuthProvider(c.env.DB, id, {
      provider_id: String(form.get('provider_id') ?? ''),
      name: String(form.get('name') ?? ''),
      client_id: String(form.get('client_id') ?? ''),
      client_secret: String(form.get('client_secret') ?? ''),
      discovery_url: String(form.get('discovery_url') ?? ''),
      authorization_url: String(form.get('authorization_url') ?? ''),
      token_url: String(form.get('token_url') ?? ''),
      user_info_url: String(form.get('user_info_url') ?? ''),
      scopes: String(form.get('scopes') ?? 'openid,profile,email'),
      pkce: form.get('pkce') === 'on',
      enabled: form.get('enabled') === 'on',
      sort_order: Number(form.get('sort_order') ?? 0),
      icon_url: String(form.get('icon_url') ?? '')
    })
    if (!result.ok) {
      return c.redirect(adminPath('oauth', { oauth_error: result.message }))
    }
    return c.redirect(adminPath('oauth', { oauth_info: '已更新' }))
  })

  app.post('/admin/oauth/:id/toggle', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    const enabled = form.get('enabled') === '1'
    await setOAuthProviderEnabled(c.env.DB, id, enabled)
    return c.redirect(adminPath('oauth', { oauth_info: enabled ? '已启用' : '已停用' }))
  })

  app.post('/admin/oauth/:id/delete', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) return csrfDenied
    const id = c.req.param('id')
    await deleteOAuthProvider(c.env.DB, id)
    return c.redirect(adminPath('oauth', { oauth_info: '已删除' }))
  })

  app.post('/admin/mail/test', async (c) => {
    const admin = await requireAdmin(c.env, c.req.raw.headers)
    if (!admin) return c.redirect('/')
    const form = await c.req.formData()
    const csrfDenied = await requireMutationCsrf(c, form)
    if (csrfDenied) {
      return c.redirect(adminPath('settings', { mail_error: '安全校验失败，请刷新页面后重试' }))
    }

    const toEmail = String(form.get('to_email') ?? '').trim()
    if (!toEmail || !toEmail.includes('@')) {
      return c.redirect(adminPath('settings', { mail_error: '请输入有效的接收邮箱' }))
    }

    try {
      const result = await sendTestEmail(c.env, toEmail)
      if (!result.ok) {
        return c.redirect(
          adminPath('settings', {
            mail_error: result.message || '测试邮件发送失败'
          })
        )
      }
      return c.redirect(
        adminPath('settings', {
          mail_info: `测试邮件已提交发送：${toEmail}`
        })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : '测试邮件发送失败'
      return c.redirect(adminPath('settings', { mail_error: msg }))
    }
  })
}
