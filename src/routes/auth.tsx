import type { Hono } from 'hono'
import { hashPassword } from 'better-auth/crypto'
import {
  createAuth,
  getCurrentSession,
  getCurrentUser,
  isSuperAdminUser
} from '../auth'
import { Layout } from '../views/Layout'
import { IndexView } from '../views/IndexView'
import { LoginView } from '../views/LoginView'
import { RegisterView } from '../views/RegisterView'
import { GitHubAgeRejectedView } from '../views/GitHubAgeRejectedView'
import { SetupView } from '../views/SetupView'
import { VerifyEmailView } from '../views/VerifyEmailView'
import { getSettings, isEmailAllowed } from '../services/settings'
import {
  countUsers,
  deleteUserCascade,
  listAllUsers,
  listRecordsByUser,
  setSuperAdmin,
  setUserRole
} from '../services/dns-records'
import { listPublicOAuthProviders } from '../services/oauth-providers'
import {
  deleteEmailVerificationsByEmail,
  findLatestEmailVerification,
  openPendingPassword,
  purgeExpiredEmailVerifications,
  sealPendingPassword,
  upsertEmailVerification,
  verifyVerificationCode
} from '../services/email-verification'
import { sendVerificationCode } from '../services/mailer'
import {
  getGitHubUser,
  githubAgeRejectedPath,
  isGitHubAgeRejectedError,
  meetsAgeRequirement,
  parseGitHubAgeRejectedMinDays
} from '../services/github'
import { type Bindings } from '../services/cloudflare-dns'
import { parseCookie, redirectFromOAuthResponse, redirectWithHeaders } from '../lib/http'
import { finalizeInviteUsage, findUserIdByEmail, requireInviteCodeIfNeeded } from '../lib/invite'

export function registerAuthRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.all('/api/auth/*', async (c) => {
    const auth = await createAuth(c.env)
    const res = await auth.handler(c.req.raw)

    // GitHub age rejection throws inside getUserInfo; better-auth surfaces it as 4xx/5xx.
    // Convert to a dedicated rejection page instead of a raw error/500.
    if (res.status >= 400 && c.req.path.includes('/oauth2/callback/github')) {
      let bodyText = ''
      try {
        bodyText = await res.clone().text()
      } catch {
        bodyText = ''
      }
      if (isGitHubAgeRejectedError(bodyText)) {
        const settings = await getSettings(c.env.DB)
        const parsed = parseGitHubAgeRejectedMinDays(bodyText)
        const minDays = parsed ?? settings.github_min_account_age_days
        return c.redirect(githubAgeRejectedPath(minDays))
      }
    }
    return res
  })

  app.get('/setup', async (c) => {
    const userCount = await countUsers(c.env.DB)
    if (userCount > 0) {
      return c.redirect('/')
    }
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) {
      return c.redirect('/')
    }
    return c.html(
      <Layout title="初始化管理员">
        <SetupView />
      </Layout>
    )
  })

  app.post('/setup', async (c) => {
    const userCount = await countUsers(c.env.DB)
    if (userCount > 0) {
      return c.redirect('/')
    }
    const form = await c.req.formData()
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const confirm = String(form.get('confirm') ?? '')

    if (!name || !email || !password) {
      return c.html(
        <Layout title="初始化管理员"><SetupView error="请填写完整" /></Layout>,
        { status: 400 }
      )
    }
    if (password !== confirm) {
      return c.html(
        <Layout title="初始化管理员"><SetupView error="两次密码不一致" /></Layout>,
        { status: 400 }
      )
    }

    const auth = await createAuth(c.env)
    try {
      const signUpRes = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      if (!signUpRes.ok) {
        const data = await signUpRes.json().catch(() => ({}))
        const msg = (data as { message?: string }).message || '创建管理员失败'
        return c.html(
          <Layout title="初始化管理员"><SetupView error={msg} /></Layout>,
          { status: signUpRes.status as 400 | 422 }
        )
      }
      // 把该用户提升为管理员，并标记为超级管理员（首个创建的用户）
      const listRes = await listAllUsers(c.env.DB)
      const newUser = listRes.find((u) => u.email === email)
      if (newUser) {
        await setUserRole(c.env.DB, newUser.id, 'admin')
        await setSuperAdmin(c.env.DB, newUser.id, true)
      }
      // 自动登录
      const signInRes = await auth.api.signInEmail({
        body: { email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      if (signInRes.ok) {
        return redirectWithHeaders('/', 302, signInRes.headers)
      }
      return c.redirect('/login')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建管理员失败'
      return c.html(
        <Layout title="初始化管理员"><SetupView error={msg} /></Layout>,
        { status: 500 }
      )
    }
  })

  // ---------- 首页 ----------
  app.get('/', async (c) => {
    const userCount = await countUsers(c.env.DB)
    if (userCount === 0) {
      return c.redirect('/setup')
    }
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (!user) {
      return c.redirect('/login')
    }
    const records = await listRecordsByUser(c.env.DB, user.id)
    return c.html(
      <Layout title="Minecraft 端口隐藏工具">
        <IndexView email={user.email} role={user.role ?? 'user'} records={records} />
      </Layout>
    )
  })

  // ---------- 登录 ----------
  app.get('/login', async (c) => {
    const next = c.req.query('next')
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) {
      return c.redirect(next || '/')
    }
    const oauthProviders = await listPublicOAuthProviders(c.env.DB)
    const error = c.req.query('error') || undefined
    const info = c.req.query('registered') ? '注册成功，请登录' : undefined
    return c.html(
      <Layout title="登录">
        <LoginView next={next} info={info} error={error} oauthProviders={oauthProviders} />
      </Layout>
    )
  })

  app.post('/login', async (c) => {
    const auth = await createAuth(c.env)
    const form = await c.req.formData()
    const next = c.req.query('next') || '/'
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    try {
      const res = await auth.api.signInEmail({
        body: { email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      if (res.ok) {
        return redirectWithHeaders(next, 302, res.headers)
      }
      const data = await res.json().catch(() => ({}))
      const message =
        (data as { message?: string }).message ||
        (res.status === 401 ? '邮箱或密码错误' : '登录失败')
      return c.html(
        <Layout title="登录"><LoginView next={next} error={message} /></Layout>,
        { status: res.status as 400 | 401 | 422 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败'
      return c.html(
        <Layout title="登录"><LoginView next={next} error={message} /></Layout>,
        { status: 500 }
      )
    }
  })

  // ---------- 注册 ----------
  app.get('/register', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) return c.redirect('/')
    const settings = await getSettings(c.env.DB)
    const oauthProviders = await listPublicOAuthProviders(c.env.DB)
    const error = c.req.query('error') || undefined
    return c.html(
      <Layout title="注册">
        <RegisterView settings={settings} oauthProviders={oauthProviders} error={error} />
      </Layout>
    )
  })

  app.post('/register', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) return c.redirect('/')
    const settings = await getSettings(c.env.DB)
    if (!settings.registration_enabled) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error="当前已关闭注册" /></Layout>,
        { status: 403 }
      )
    }
    if (settings.registration_mode === 'oauth') {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error="仅支持 GitHub 注册" /></Layout>,
        { status: 403 }
      )
    }

    const auth = await createAuth(c.env)
    const form = await c.req.formData()
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const inviteCode = String(form.get('invite_code') ?? '').trim()

    if (!name || !email || !password) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error="请填写完整信息" /></Layout>,
        { status: 400 }
      )
    }

    const emailCheck = isEmailAllowed(email, settings)
    if (!emailCheck.ok) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={emailCheck.reason!} /></Layout>,
        { status: 400 }
      )
    }

    const inviteCheck = await requireInviteCodeIfNeeded(c.env.DB, settings, inviteCode)
    if (!inviteCheck.ok) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={inviteCheck.message} /></Layout>,
        { status: 400 }
      )
    }

  // 启用 Resend 时走验证码流程
    if (settings.resend_enabled && settings.resend_api_key && settings.resend_from) {
      const code = String(Math.floor(100000 + Math.random() * 900000))
      const codeHash = await hashPassword(code)
      const expires_at = Date.now() + 10 * 60 * 1000
      const passwordSealed = await sealPendingPassword(c.env.BETTER_AUTH_SECRET, password)
      await purgeExpiredEmailVerifications(c.env.DB)
      await upsertEmailVerification(c.env.DB, {
        email,
        name,
        passwordSealed,
        codeHash,
        expiresAt: expires_at,
        inviteCode: inviteCheck.code
      })
      const result = await sendVerificationCode(c.env, email, code)
      if (!result.ok) {
        return c.html(
          <Layout title="邮箱验证"><RegisterView settings={settings} error={result.message || '验证码发送失败'} /></Layout>,
          { status: 500 }
        )
      }
      return c.html(
        <Layout title="邮箱验证">
          <VerifyEmailView email={email} />
        </Layout>
      )
    }

  // 未启用 SMTP 时直接完成注册
    try {
      const res = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: c.req.raw.headers,
        asResponse: true
      })
      if (res.ok) {
        const newUserId = await findUserIdByEmail(c.env.DB, email)
        const used = await finalizeInviteUsage(c.env.DB, inviteCheck.code, newUserId)
        if (!used.ok && newUserId) {
          await deleteUserCascade(c.env.DB, newUserId)
          return c.html(
            <Layout title="注册"><RegisterView settings={settings} error={used.message} /></Layout>,
            { status: 400 }
          )
        }
        return redirectWithHeaders('/login?registered=1', 302, res.headers)
      }
      const data = await res.json().catch(() => ({}))
      const message =
        (data as { message?: string }).message ||
        (res.status === 422 ? '该邮箱已注册' : '注册失败')
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={message} /></Layout>,
        { status: res.status as 400 | 401 | 422 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : '注册失败'
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={message} /></Layout>,
        { status: 500 }
      )
    }
  })

  app.post('/verify-email', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) return c.redirect('/')
    const settings = await getSettings(c.env.DB)
    const form = await c.req.formData()
    const email = String(form.get('email') ?? '').trim()
    const code = String(form.get('code') ?? '').trim()

    if (!email || !code) {
      return c.html(
        <Layout title="邮箱验证"><VerifyEmailView email={email} error="参数缺失" /></Layout>,
        { status: 400 }
      )
    }

    const row = await findLatestEmailVerification(c.env.DB, email)

    if (!row) {
      return c.html(
        <Layout title="邮箱验证"><VerifyEmailView email={email} error="未找到验证记录，请重新注册" /></Layout>,
        { status: 400 }
      )
    }
    if (Date.now() > row.expires_at) {
      return c.html(
        <Layout title="邮箱验证"><VerifyEmailView email={email} error="验证码已过期，请重新注册" /></Layout>,
        { status: 400 }
      )
    }
    const codeOk = await verifyVerificationCode(code, row.code_hash)
    if (!codeOk) {
      return c.html(
        <Layout title="邮箱验证"><VerifyEmailView email={email} error="验证码错误" /></Layout>,
        { status: 400 }
      )
    }

    let plainPassword: string
    try {
      plainPassword = await openPendingPassword(c.env.BETTER_AUTH_SECRET, row.password)
    } catch {
      return c.html(
        <Layout title="邮箱验证"><VerifyEmailView email={email} error="验证记录无效，请重新注册" /></Layout>,
        { status: 400 }
      )
    }

    const auth = await createAuth(c.env)
    try {
      const res = await auth.api.signUpEmail({
        body: { name: row.name, email, password: plainPassword },
        headers: c.req.raw.headers,
        asResponse: true
      })
      if (res.ok) {
        await deleteEmailVerificationsByEmail(c.env.DB, email)
        return redirectWithHeaders('/login?registered=1', 302, res.headers)
      }
      const data = await res.json().catch(() => ({}))
      const message =
        (data as { message?: string }).message ||
        (res.status === 422 ? '该邮箱已被注册' : '注册失败')
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={message} /></Layout>,
        { status: res.status as 400 | 401 | 422 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : '注册失败'
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} error={message} /></Layout>,
        { status: 500 }
      )
    }
  })

  app.on(['GET', 'POST'], '/logout', async (c) => {
    const auth = await createAuth(c.env)
    try {
      const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true })
      return redirectWithHeaders('/login', 302, res.headers)
    } catch {
      return c.redirect('/login')
    }
  })

  app.post('/login/oauth', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    const next = c.req.query('next') || '/'
    if (user) return c.redirect(next)
    const form = await c.req.formData()
    const providerId = String(form.get('provider_id') ?? '').trim()
    if (!providerId) {
      return c.redirect('/login?error=' + encodeURIComponent('请选择 OAuth 应用'))
    }
    const auth = await createAuth(c.env)
    try {
      // genericOAuth endpoint returns JSON { url, redirect }; convert to HTTP redirect
      const res = await (auth.api as any).signInWithOAuth2({
        body: {
          providerId,
          callbackURL: next,
          errorCallbackURL: '/login?error=' + encodeURIComponent('OAuth 登录失败')
        },
        headers: c.req.raw.headers,
        asResponse: true
      })
      return await redirectFromOAuthResponse(
        res,
        '/login?error=' + encodeURIComponent('OAuth 登录失败')
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OAuth 登录失败'
      return c.redirect('/login?error=' + encodeURIComponent(msg))
    }
  })

  app.post('/register/oauth', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    if (user) return c.redirect('/')
    const settings = await getSettings(c.env.DB)
    if (!settings.registration_enabled) {
      return c.redirect('/register')
    }
    if (settings.registration_mode === 'email') {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} oauthProviders={await listPublicOAuthProviders(c.env.DB)} error="?????????" /></Layout>,
        { status: 403 }
      )
    }
    const form = await c.req.formData()
    const providerId = String(form.get('provider_id') ?? '').trim()
    const inviteCode = String(form.get('invite_code') ?? '').trim()
    if (!providerId) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} oauthProviders={await listPublicOAuthProviders(c.env.DB)} error="请选择 OAuth 应用" /></Layout>,
        { status: 400 }
      )
    }
    const inviteCheck = await requireInviteCodeIfNeeded(c.env.DB, settings, inviteCode)
    if (!inviteCheck.ok) {
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} oauthProviders={await listPublicOAuthProviders(c.env.DB)} error={inviteCheck.message} /></Layout>,
        { status: 400 }
      )
    }
    const auth = await createAuth(c.env)
    try {
      const res = await (auth.api as any).signInWithOAuth2({
        body: {
          providerId,
          callbackURL: '/register/oauth/done',
          errorCallbackURL: '/register?error=' + encodeURIComponent('OAuth 登录失败')
        },
        headers: c.req.raw.headers,
        asResponse: true
      })
      const redirected = await redirectFromOAuthResponse(
        res,
        '/register?error=' + encodeURIComponent('OAuth 登录失败')
      )
      if (inviteCheck.code) {
        const headers = new Headers(redirected.headers)
        headers.append(
          'Set-Cookie',
          `pending_invite_code=${encodeURIComponent(inviteCheck.code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`
        )
        return new Response(redirected.body, { status: redirected.status, headers })
      }
      return redirected
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OAuth 登录失败'
      return c.html(
        <Layout title="注册"><RegisterView settings={settings} oauthProviders={await listPublicOAuthProviders(c.env.DB)} error={msg} /></Layout>,
        { status: 500 }
      )
    }
  })

  app.get('/register/github-age-rejected', async (c) => {
    const settings = await getSettings(c.env.DB)
    const minDays = Math.max(
      0,
      Number(c.req.query('min_days') ?? settings.github_min_account_age_days) || 0
    )
    const actualDaysRaw = c.req.query('actual_days')
    const actualDays =
      actualDaysRaw == null || actualDaysRaw === ''
        ? null
        : Math.max(0, Number(actualDaysRaw) || 0)
    return c.html(
      <Layout title="GitHub 账号天数未达标">
        <GitHubAgeRejectedView minDays={minDays} actualDays={actualDays} />
      </Layout>
    )
  })

  app.get('/register/oauth/done', async (c) => {
    const user = await getCurrentUser(c.env, c.req.raw.headers)
    const settings = await getSettings(c.env.DB)
    const cookieHeader = c.req.header('Cookie') || ''
    const pendingInvite = parseCookie(cookieHeader, 'pending_invite_code')
    const clearInviteCookie = 'pending_invite_code=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    if (!user) {
      return redirectWithHeaders('/login', 302, new Headers({ 'Set-Cookie': clearInviteCookie }))
    }

    const failOAuthRegister = async (message: string, status: 400 | 403 = 400) => {
      await deleteUserCascade(c.env.DB, user.id)
      return c.html(
        <Layout title="注册">
          <RegisterView
            settings={settings}
            oauthProviders={await listPublicOAuthProviders(c.env.DB)}
            error={message}
          />
        </Layout>,
        { status, headers: { 'Set-Cookie': clearInviteCookie } }
      )
    }

    const createdAtMs = new Date(user.createdAt).getTime()
    const isNewUser = Number.isFinite(createdAtMs) && Date.now() - createdAtMs < 5 * 60 * 1000

    // Defense-in-depth: if a brand-new GitHub user somehow got created, re-check age and roll back.
    if (isNewUser && settings.github_min_account_age_days > 0) {
      const account = await c.env.DB
        .prepare(
          "SELECT accessToken FROM account WHERE userId = ? AND providerId = 'github' ORDER BY updatedAt DESC LIMIT 1"
        )
        .bind(user.id)
        .first<{ accessToken: string | null }>()

      if (!account) {
        // Not a GitHub-linked signup; nothing to enforce here.
      } else if (!account.accessToken) {
        await deleteUserCascade(c.env.DB, user.id)
        return redirectWithHeaders(
          githubAgeRejectedPath(settings.github_min_account_age_days),
          302,
          new Headers({ 'Set-Cookie': clearInviteCookie })
        )
      } else {
        const ghUser = await getGitHubUser(account.accessToken)
        // Fail closed when GitHub profile cannot be verified under an age limit.
        if (!ghUser || !meetsAgeRequirement(ghUser.created_at, settings.github_min_account_age_days)) {
          await deleteUserCascade(c.env.DB, user.id)
          const actualDays = ghUser
            ? (Date.now() - Date.parse(ghUser.created_at)) / 86400000
            : null
          const path =
            githubAgeRejectedPath(settings.github_min_account_age_days) +
            (actualDays != null && Number.isFinite(actualDays)
              ? `&actual_days=${encodeURIComponent(String(Math.max(0, Math.floor(actualDays))))}`
              : '')
          return redirectWithHeaders(path, 302, new Headers({ 'Set-Cookie': clearInviteCookie }))
        }
      }
    }

    if (settings.invite_required && isNewUser) {
      const used = await finalizeInviteUsage(c.env.DB, pendingInvite, user.id)
      if (!used.ok) {
        return await failOAuthRegister(used.message)
      }
    }
    return redirectWithHeaders('/', 302, new Headers({ 'Set-Cookie': clearInviteCookie }))
  })
}
