import { Hono } from 'hono'
import { createAuth, getCurrentUser, getCurrentSession, requireAdmin, isSuperAdminUser } from './auth'
import { Layout } from './views/Layout'
import { IndexView } from './views/IndexView'
import { LoginView } from './views/LoginView'
import { RegisterView } from './views/RegisterView'
import { GitHubAgeRejectedView } from './views/GitHubAgeRejectedView'
import { SetupView } from './views/SetupView'
import { VerifyEmailView } from './views/VerifyEmailView'
import { AdminView } from './views/AdminView'
import {
  getSettings,
  updateSettings,
  isEmailAllowed,
  type Settings
} from './services/settings'
import {
  listRecordsByUser,
  listAllRecords,
  findRecordById,
  findRecordByHostName,
  insertRecord,
  deleteRecordRow,
  listAllUsers,
  findUserById,
  setUserRole,
  setUserRecordLimit,
  setSuperAdmin,
  isSuperAdmin,
  countUsers,
  countRecordsByUser,
  hasUnlimitedDnsLimits,
  resolveMinSubdomainLength,
  resolveUserRecordLimit,
  deleteUserCascade,
  genId,
  type DnsRecordRow,
  type UserListRow
} from './services/dns-records'
import {
  createOAuthProvider,
  deleteOAuthProvider,
  listOAuthProviders,
  listPublicOAuthProviders,
  setOAuthProviderEnabled,
  OAUTH_TEMPLATES,
  updateOAuthProvider,
  type OAuthProviderPublic,
  type OAuthProviderRow
} from './services/oauth-providers'
import {
  assertInviteCodeAvailable,
  consumeInviteCode,
  createInviteCode,
  listInviteCodes,
  revokeInviteCode
} from './services/invite-codes'
import { sendVerificationCode } from './services/mailer'
import {
  getGitHubUser,
  githubAgeErrorMessage,
  githubAgeRejectedPath,
  isGitHubAgeRejectedError,
  meetsAgeRequirement,
  parseGitHubAgeRejectedMinDays
} from './services/github'

type Bindings = CloudflareBindings & {
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
}

type CloudflareError = {
  message?: string
}

type CloudflareListResult<T> = {
  success: boolean
  result: T[]
  errors?: CloudflareError[]
}

type CloudflareSingleResult<T> = {
  success: boolean
  result: T
  errors?: CloudflareError[]
}

type CloudflareZone = {
  id: string
}

type CloudflareDnsRecord = {
  id: string
  type: string
  name: string
  content?: string
}

type DnsRecordBody =
  | {
      type: 'A' | 'AAAA' | 'CNAME'
      name: string
      content: string
      ttl: 1
      proxied: false
    }
  | {
      type: 'SRV'
      name: string
      ttl: 1
      data: {
        priority: number
        weight: number
        port: number
        target: string
      }
    }

const app = new Hono<{ Bindings: Bindings }>()

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

app.get('/api/domains', async (c) => {
  const domains = getAllowedDomains(c.env)
  const settings = await getSettings(c.env.DB)
  const session = await getCurrentSession(c.env, c.req.raw.headers)
  let recordLimit: number | null = null
  let minSubdomainLength = Math.max(0, settings.min_subdomain_length)
  if (session) {
    const userRow = await findUserById(c.env.DB, session.user.id)
    recordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
    minSubdomainLength = resolveMinSubdomainLength(userRow, settings.min_subdomain_length)
  }
  return c.json({
    success: true,
    domains,
    min_subdomain_length: minSubdomainLength,
    record_limit: recordLimit,
    max_records_per_user: settings.max_records_per_user
  })
})

app.post('/api/create-dns', async (c) => {
  try {
    const session = await getCurrentSession(c.env, c.req.raw.headers)
    if (!session) {
      return c.json({ success: false, message: '未登录，请先登录' }, 401)
    }
    const userId = session.user.id
    const userRow = await findUserById(c.env.DB, userId)

    const body = await c.req.json()
    const domains = getAllowedDomains(c.env)

    if (domains.length === 0) {
      return c.json({ success: false, message: '后端未配置可用根域名 DOMAINS' }, 500)
    }

    const request = parseCreateDnsRequest(body, domains)
    if (!request.ok) {
      return c.json({ success: false, message: request.message }, 400)
    }

    const { subdomain, rootDomain, serverAddress, port, targetRecordType } = request.value
    const token = getCloudflareApiToken(c.env, rootDomain)
    if (!token) {
      return c.json(
        { success: false, message: `后端未配置根域名 ${rootDomain} 对应的 CLOUDFLARE_API_TOKEN` },
        500
      )
    }

    // 子域名最小长度校验
    const settings = await getSettings(c.env.DB)
    const minLen = resolveMinSubdomainLength(userRow, settings.min_subdomain_length)
    // subdomain 可包含多级如 play.mc，整体长度按用户填写的子域名原始字符串判断
    const subdomainInput = String((body as Record<string, unknown>).subdomain ?? '').trim()
    if (minLen > 0 && subdomainInput.length < minLen) {
      return c.json(
        {
          success: false,
          message: `子域名长度不能少于 ${minLen} 个字符`
        },
        400
      )
    }

    // 记录数上限校验
    const userRecordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
    if (userRecordLimit > 0) {
      const currentCount = await countRecordsByUser(c.env.DB, userId)
      if (currentCount >= userRecordLimit) {
        return c.json(
          {
            success: false,
            message: `已达记录数量上限（${userRecordLimit} 条），无法继续创建`
          },
          403
        )
      }
    }

    const hostName = `${subdomain}.${rootDomain}`
    const srvName = `_minecraft._tcp.${hostName}`

    // D1 已被占用则直接拒绝（更快的本地校验）
    const existing = await findRecordByHostName(c.env.DB, hostName)
    if (existing) {
      return c.json(
        { success: false, code: 'record_occupied', message: `域名 ${hostName} 已被占用，请换一个子域名` },
        409
      )
    }

    const zoneId = await fetchZoneId(token, rootDomain)
    const occupiedRecords = await findOccupiedRecords(token, zoneId, [hostName, srvName])
    if (occupiedRecords.length > 0) {
      return c.json(
        { success: false, code: 'record_occupied', message: `域名 ${hostName} 已被占用，请换一个子域名` },
        409
      )
    }

    const targetRecord = await createDnsRecord(token, zoneId, {
      type: targetRecordType,
      name: hostName,
      content: serverAddress,
      ttl: 1,
      proxied: false
    })

    const srvRecord = await createDnsRecord(token, zoneId, {
      type: 'SRV',
      name: srvName,
      ttl: 1,
      data: { priority: 0, weight: 5, port, target: hostName }
    })

    await insertRecord(c.env.DB, {
      user_id: userId,
      root_domain: rootDomain,
      subdomain,
      host_name: hostName,
      server_address: serverAddress,
      port,
      target_type: targetRecordType,
      target_record_id: targetRecord.id,
      srv_record_id: srvRecord.id
    })

    return c.json({
      success: true,
      message: `DNS 记录已创建：${hostName} -> ${serverAddress}，Minecraft Java 端口 ${port}`,
      records: { target: targetRecord, srv: srvRecord }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '请求处理失败'
    return c.json({ success: false, message }, 500)
  }
})

function redirectWithHeaders(location: string, status: 302 | 303 = 302, headers?: Headers): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Location', location)
  return new Response(null, { status, headers: responseHeaders })
}

async function redirectFromOAuthResponse(
  res: Response,
  fallbackErrorPath: string
): Promise<Response> {
  // better-auth genericOAuth signInWithOAuth2 returns JSON { url, redirect }
  // instead of an HTTP redirect. Convert so browser form POSTs jump correctly.
  const headers = new Headers(res.headers)
  const contentType = (headers.get('content-type') || '').toLowerCase()

  if (res.status >= 300 && res.status < 400) {
    return new Response(null, { status: res.status, headers })
  }

  let payload: { url?: string; redirect?: boolean } | null = null
  if (
    contentType.includes('application/json') ||
    contentType.includes('text/json') ||
    contentType.includes('+json')
  ) {
    try {
      payload = (await res.clone().json()) as { url?: string; redirect?: boolean }
    } catch {
      payload = null
    }
  } else {
    try {
      const textBody = await res.clone().text()
      if (textBody.trim().startsWith('{')) {
        payload = JSON.parse(textBody) as { url?: string; redirect?: boolean }
      }
    } catch {
      payload = null
    }
  }

  if (payload?.url && payload.redirect !== false) {
    // Keep Set-Cookie headers from better-auth (state/pkce cookies).
    headers.set('Location', payload.url)
    headers.delete('content-type')
    headers.delete('content-length')
    return new Response(null, { status: 302, headers })
  }

  if (!res.ok) {
    return redirectWithHeaders(fallbackErrorPath, 302, headers)
  }

  return new Response(res.body, { status: res.status, headers })
}


async function requireInviteCodeIfNeeded(
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

async function findUserIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM user WHERE email = ? LIMIT 1')
    .bind(email)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function finalizeInviteUsage(
  db: D1Database,
  inviteCode: string | null | undefined,
  userId: string | null | undefined
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!inviteCode || !userId) return { ok: true }
  return await consumeInviteCode(db, inviteCode, userId)
}

function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';')
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (rawKey === name) {
      try {
        return decodeURIComponent(rest.join('=') || '')
      } catch {
        return rest.join('=') || ''
      }
    }
  }
  return null
}


// ---------- Onboarding ----------
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
    const codeHash = await sha256(code)
    const id = genId()
    const expires_at = Date.now() + 10 * 60 * 1000
    await c.env.DB
      .prepare('INSERT INTO email_verification (id, email, name, password, code_hash, expires_at, created_at, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, name, password, codeHash, expires_at, Date.now(), inviteCheck.code)
      .run()
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

  const row = await c.env.DB
    .prepare('SELECT * FROM email_verification WHERE email = ? ORDER BY created_at DESC LIMIT 1')
    .bind(email)
    .first<{ id: string; name: string; password: string; code_hash: string; expires_at: number }>()

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
  const expected = await sha256(code)
  if (expected !== row.code_hash) {
    return c.html(
      <Layout title="邮箱验证"><VerifyEmailView email={email} error="验证码错误" /></Layout>,
      { status: 400 }
    )
  }

  const auth = await createAuth(c.env)
  try {
    const res = await auth.api.signUpEmail({
      body: { name: row.name, email, password: row.password },
      headers: c.req.raw.headers,
      asResponse: true
    })
    if (res.ok) {
      await c.env.DB.prepare('DELETE FROM email_verification WHERE email = ?').bind(email).run()
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

// ---------- 普通用户删除自己的记录 ----------
app.post('/dns/:id/delete', async (c) => {
  const session = await getCurrentSession(c.env, c.req.raw.headers)
  if (!session) return c.redirect('/login')
  const id = c.req.param('id')
  const record = await findRecordById(c.env.DB, id)
  if (!record) return c.redirect('/')
  if (record.user_id !== session.user.id) {
    return c.redirect('/')
  }
  await deleteRecordAndCloudflare(c.env, record)
  return c.redirect('/')
})

// ---------- 管理员后台 ----------
app.get('/admin', async (c) => {
  const user = await requireAdmin(c.env, c.req.raw.headers)
  if (!user) return c.redirect('/')
  const [users, records, settings, inviteCodes, oauthProviders] = await Promise.all([
    listAllUsers(c.env.DB),
    listAllRecords(c.env.DB),
    getSettings(c.env.DB),
    listInviteCodes(c.env.DB),
    listOAuthProviders(c.env.DB)
  ])
  return c.html(
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
        createError={c.req.query('create_error') ?? undefined}
        inviteError={c.req.query('invite_error') ?? undefined}
        inviteInfo={c.req.query('invite_info') ?? undefined}
        oauthError={c.req.query('oauth_error') ?? undefined}
        oauthInfo={c.req.query('oauth_info') ?? undefined}
      />
    </Layout>
  )
})

app.post('/admin/settings', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const form = await c.req.formData()
  const current = await getSettings(c.env.DB)

  const mode = String(form.get('registration_mode') ?? 'email')
  const modeNorm: 'email' | 'oauth' | 'both' =
    mode === 'oauth' || mode === 'github' ? 'oauth' : mode === 'both' ? 'both' : 'email'

  const whitelistSuffixesRaw = String(form.get('email_whitelist_suffixes') ?? '').trim()
  const blacklistSuffixesRaw = String(form.get('email_blacklist_suffixes') ?? '').trim()

  const resendApiKeyFromForm = String(form.get('resend_api_key') ?? '').trim()
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
    resend_from: String(form.get('resend_from') ?? '').trim() || null,
    max_records_per_user: Math.max(0, Number(form.get('max_records_per_user') ?? 0) || 0),
    min_subdomain_length: Math.max(0, Number(form.get('min_subdomain_length') ?? 0) || 0)
  }
  // API Key 留空则保留既有
  if (resendApiKeyFromForm) {
    patch.resend_api_key = resendApiKeyFromForm
  } else if (!current.resend_api_key) {
    patch.resend_api_key = null
  }

  await updateSettings(c.env.DB, patch)
  return c.redirect('/admin')
})

app.post('/admin/users/:id/role', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  if (!isSuperAdminUser(admin)) return c.redirect('/admin')
  const id = c.req.param('id')
  if (id === admin.id) return c.redirect('/admin')
  // 超级管理员不能被其他管理员降级
  const targetSuper = await isSuperAdmin(c.env.DB, id)
  if (targetSuper) return c.redirect('/admin')
  const form = await c.req.formData()
  const roleFromForm = String(form.get('role') ?? '')
  if (roleFromForm === 'admin' || roleFromForm === 'user') {
    await setUserRole(c.env.DB, id, roleFromForm)
  }
  return c.redirect('/admin')
})

app.post('/admin/users/:id/delete', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  if (id === admin.id) return c.redirect('/admin')
  const target = await findUserById(c.env.DB, id)
  if (!target) return c.redirect('/admin')
  if (target.role === 'admin' && !isSuperAdminUser(admin)) return c.redirect('/admin')
  // 禁止删除超级管理员
  const targetSuper = await isSuperAdmin(c.env.DB, id)
  if (targetSuper) return c.redirect('/admin')
  // 同时级联删除其 DNS 记录 + Cloudflare 中对应记录
  const records = await listRecordsByUser(c.env.DB, id)
  for (const r of records) {
    await deleteRecordAndCloudflare(c.env, r)
  }
  await deleteUserCascade(c.env.DB, id)
  return c.redirect('/admin')
})

app.post('/admin/users/:id/limit', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  const target = await findUserById(c.env.DB, id)
  if (!target || hasUnlimitedDnsLimits(target)) return c.redirect('/admin')
  const form = await c.req.formData()
  const raw = String(form.get('record_limit') ?? '').trim()
  let limit: number | null = null
  if (raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) {
      limit = Math.floor(n)
    } else {
      return c.redirect('/admin')
    }
  }
  await setUserRecordLimit(c.env.DB, id, limit)
  return c.redirect('/admin')
})

// 管理员手动创建用户（无需走注册流程）
app.post('/admin/users/create', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  const email = String(form.get('email') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const role = isSuperAdminUser(admin) && String(form.get('role') ?? 'user') === 'admin' ? 'admin' : 'user'

  if (!name || !email || password.length < 8) {
    return c.redirect('/admin?create_error=' + encodeURIComponent('参数不完整或密码少于8位'))
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
      const msg = (data as { message?: string }).message || '创建用户失败'
      return c.redirect('/admin?create_error=' + encodeURIComponent(msg))
    }
    const listRes = await listAllUsers(c.env.DB)
    const newUser = listRes.find((u) => u.email === email)
    if (newUser && role === 'admin') {
      await setUserRole(c.env.DB, newUser.id, 'admin')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '创建用户失败'
    return c.redirect('/admin?create_error=' + encodeURIComponent(msg))
  }
  return c.redirect('/admin')
})

app.post('/admin/dns/:id/delete', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  const record = await findRecordById(c.env.DB, id)
  if (record) {
    await deleteRecordAndCloudflare(c.env, record)
  }
  return c.redirect('/admin')
})


app.post('/admin/invites/create', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
// 仅管理员/超级管理员可生成(requireAdmin 已校验 role=admin)
  const settings = await getSettings(c.env.DB)
  if (!settings.invite_required) {
    return c.redirect('/admin?invite_error=' + encodeURIComponent('请先开启邀请码注册'))
  }
  try {
    const created = await createInviteCode(c.env.DB, admin.id)
    return c.redirect('/admin?invite_info=' + encodeURIComponent(`已生成邀请码 ${created.code}`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : '生成邀请码失败'
    return c.redirect('/admin?invite_error=' + encodeURIComponent(msg))
  }
})

app.post('/admin/invites/:id/revoke', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  const result = await revokeInviteCode(c.env.DB, id)
  if (!result.ok) {
    return c.redirect('/admin?invite_error=' + encodeURIComponent(result.message))
  }
  return c.redirect('/admin?invite_info=' + encodeURIComponent('邀请码已作废'))
})


// ---------- 通用 OAuth 登录 / 注册 ----------
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

// ---------- OAuth 管理（后台） ----------
app.post('/admin/oauth/create', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const form = await c.req.formData()
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
    return c.redirect('/admin?oauth_error=' + encodeURIComponent(result.message))
  }
  return c.redirect('/admin?oauth_info=' + encodeURIComponent(`已添加 OAuth 应用 ${result.provider.name}`))
})

app.post('/admin/oauth/:id/update', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  const form = await c.req.formData()
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
    return c.redirect('/admin?oauth_error=' + encodeURIComponent(result.message))
  }
  return c.redirect('/admin?oauth_info=' + encodeURIComponent('OAuth 应用已更新'))
})

app.post('/admin/oauth/:id/toggle', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  const form = await c.req.formData()
  const enabled = form.get('enabled') === '1'
  await setOAuthProviderEnabled(c.env.DB, id, enabled)
  return c.redirect('/admin?oauth_info=' + encodeURIComponent(enabled ? '已启用' : '已禁用'))
})

app.post('/admin/oauth/:id/delete', async (c) => {
  const admin = await requireAdmin(c.env, c.req.raw.headers)
  if (!admin) return c.redirect('/')
  const id = c.req.param('id')
  await deleteOAuthProvider(c.env.DB, id)
  return c.redirect('/admin?oauth_info=' + encodeURIComponent('OAuth 应用已删除'))
})

export default app

async function deleteRecordAndCloudflare(
  env: Bindings,
  record: DnsRecordRow
): Promise<void> {
  const token = getCloudflareApiToken(env, record.root_domain)
  if (token) {
    const zoneId = await fetchZoneId(token, record.root_domain).catch(() => null)
    if (zoneId) {
      await deleteCloudflareDnsRecord(token, zoneId, record.target_record_id).catch(() => {})
      if (record.srv_record_id) {
        await deleteCloudflareDnsRecord(token, zoneId, record.srv_record_id).catch(() => {})
      }
    }
  }
  await deleteRecordRow(env.DB, record.id)
}

async function deleteCloudflareDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`
  await sendCloudflareRequest(token, url, { method: 'DELETE' })
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}

function getCloudflareApiToken(env: Bindings, rootDomain: string): string | null {
  if (!rootDomain) return null
  const key = `${rootDomain.replace(/\./g, '_')}_CLOUDFLARE_API_TOKEN`
  const value = (env as unknown as Record<string, string | undefined>)[key]
  return value && value.trim() ? value.trim() : null
}

function getAllowedDomains(env: Bindings): string[] {
  const raw = env.DOMAINS as unknown as string | string[] | undefined

  if (Array.isArray(raw)) {
    return uniqueDomains(raw)
  }

  if (!raw || !raw.trim()) {
    return []
  }

  const trimmed = raw.trim()

  try {
    const parsed = JSON.parse(trimmed)

    if (Array.isArray(parsed)) {
      return uniqueDomains(parsed)
    }

    if (typeof parsed === 'string') {
      return uniqueDomains([parsed])
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return uniqueDomains(trimmed.split(','))
}

function uniqueDomains(values: unknown[]): string[] {
  const seen = new Set<string>()
  const domains: string[] = []

  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }

    const domain = normalizeDomain(value)
    if (!domain || seen.has(domain)) {
      continue
    }

    seen.add(domain)
    domains.push(domain)
  }

  return domains
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
}

function parseCreateDnsRequest(
  body: unknown,
  domains: string[]
):
  | {
      ok: true
      value: {
        subdomain: string
        rootDomain: string
        serverAddress: string
        port: number
        targetRecordType: 'A' | 'AAAA' | 'CNAME'
      }
    }
  | { ok: false; message: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: '请求体格式不正确' }
  }

  const data = body as Record<string, unknown>
  const subdomain = normalizeDomain(String(data.subdomain ?? ''))
  const rootDomain = normalizeDomain(String(data.rootDomain ?? ''))
  const rawServerAddress = String(data.serverAddress ?? data.ip ?? '').trim()
  const serverAddress = normalizeServerAddress(rawServerAddress)
  const port = parsePort(data.port)
  const targetRecordType = getTargetRecordType(serverAddress)

  if (!isValidSubdomain(subdomain)) {
    return { ok: false, message: '子域名格式不正确，只能使用普通域名标签，例如 play 或 mc.play' }
  }

  if (!domains.includes(rootDomain)) {
    return { ok: false, message: '根域名不在后端允许列表中' }
  }

  if (subdomain === rootDomain || subdomain.endsWith(`.${rootDomain}`)) {
    return { ok: false, message: '子域名只需要填写前缀部分，例如 play，不要填写完整根域名' }
  }

  if (!targetRecordType) {
    return { ok: false, message: '服务器地址必须是合法的 IPv4、IPv6 或域名' }
  }

  if (targetRecordType === 'CNAME' && serverAddress === `${subdomain}.${rootDomain}`) {
    return { ok: false, message: '目标域名不能和要创建的域名相同' }
  }

  if (!port) {
    return { ok: false, message: '端口必须是 1 到 65535 之间的整数' }
  }

  return {
    ok: true,
    value: {
      subdomain,
      rootDomain,
      serverAddress,
      port,
      targetRecordType
    }
  }
}

function parsePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number(String(value ?? '').trim())

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }

  return port
}

function normalizeServerAddress(value: string): string {
  return isIPv6(value) ? value : normalizeDomain(value)
}

function getTargetRecordType(value: string): 'A' | 'AAAA' | 'CNAME' | null {
  if (isIPv4(value)) {
    return 'A'
  }

  if (isIPv6(value)) {
    return 'AAAA'
  }

  if (isValidHostname(value)) {
    return 'CNAME'
  }

  return null
}

function isIPv4(ip: string): boolean {
  const parts = ip.split('.')

  if (parts.length !== 4) {
    return false
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function isIPv6(ip: string): boolean {
  if (!ip.includes(':')) {
    return false
  }

  try {
    new URL(`http://[${ip}]/`)
    return true
  } catch {
    return false
  }
}

function isValidSubdomain(value: string): boolean {
  if (!value || value.length > 253 || value.includes('..')) {
    return false
  }

  return value.split('.').every(isValidDomainLabel)
}

function isValidHostname(value: string): boolean {
  if (!value || value.length > 253 || value.includes('..')) {
    return false
  }

  return value.split('.').every(isValidDomainLabel)
}

function isValidDomainLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

async function fetchZoneId(token: string, domain: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`
  const data = await sendCloudflareRequest<CloudflareListResult<CloudflareZone>>(token, url)

  if (data.success && data.result.length > 0) {
    return data.result[0].id
  }

  throw new Error(`未能在 Cloudflare 账户中找到域名 ${domain}`)
}

async function findOccupiedRecords(
  token: string,
  zoneId: string,
  names: string[]
): Promise<CloudflareDnsRecord[]> {
  const recordLists = await Promise.all(names.map((name) => findDnsRecordsByName(token, zoneId, name)))
  return recordLists.flat()
}

async function findDnsRecordsByName(
  token: string,
  zoneId: string,
  name: string
): Promise<CloudflareDnsRecord[]> {
  const params = new URLSearchParams({
    'name.exact': name,
    match: 'all',
    per_page: '100'
  })
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${params}`
  const data = await sendCloudflareRequest<CloudflareListResult<CloudflareDnsRecord>>(token, url)

  if (!data.success) {
    throw new Error(getCloudflareErrorMessage(data.errors))
  }

  return data.result
}

async function createDnsRecord(
  token: string,
  zoneId: string,
  body: DnsRecordBody
): Promise<CloudflareDnsRecord> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`
  const data = await sendCloudflareRequest<CloudflareSingleResult<CloudflareDnsRecord>>(token, url, {
    method: 'POST',
    body: JSON.stringify(body)
  })

  if (!data.success) {
    throw new Error(getCloudflareErrorMessage(data.errors))
  }

  return data.result
}

async function sendCloudflareRequest<T>(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    ...init,
    headers
  })
  const text = await response.text()
  const data = parseJsonResponse<T>(text)

  if (!response.ok) {
    const message =
      isCloudflareErrorResponse(data) && data.errors
        ? getCloudflareErrorMessage(data.errors)
        : text || 'Cloudflare 返回非 JSON 错误'
    throw new Error(`Cloudflare API 请求失败: ${response.status} ${message}`)
  }

  return data
}

function parseJsonResponse<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function isCloudflareErrorResponse(value: unknown): value is { errors?: CloudflareError[] } {
  return Boolean(value && typeof value === 'object' && 'errors' in value)
}

function getCloudflareErrorMessage(errors: CloudflareError[] | undefined): string {
  return errors?.map((error) => error.message).filter(Boolean).join('; ') || 'Cloudflare 返回未知错误'
}


