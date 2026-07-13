import type { FC } from 'hono/jsx'
import type { DnsRecordRow, UserListRow } from '../services/dns-records'
import type { InviteCodeRow } from '../services/invite-codes'
import type { OAuthProviderRow, OAuthTemplate } from '../services/oauth-providers'
import type { Settings } from '../services/settings'

type AdminTab = 'settings' | 'oauth' | 'invites' | 'users' | 'dns'

function formatEmailDisplay(email: string): { primary: string; full: string; isSynthetic: boolean } {
  const full = email || ''
  const lower = full.toLowerCase()
  // better-auth / generic OAuth often fills missing emails with long reserved/synthetic addresses
  const isSynthetic =
    lower.includes('users.noreply') ||
    lower.includes('noreply.') ||
    lower.includes('@oauth.') ||
    lower.includes('privateemail') ||
    lower.endsWith('.local') ||
    full.length > 42

  if (!isSynthetic) {
    return { primary: full, full, isSynthetic: false }
  }

  const at = full.indexOf('@')
  if (at <= 0) {
    const short = full.length > 28 ? full.slice(0, 12) + '…' + full.slice(-8) : full
    return { primary: short, full, isSynthetic: true }
  }
  const local = full.slice(0, at)
  const domain = full.slice(at + 1)
  const localShort = local.length > 16 ? local.slice(0, 10) + '…' + local.slice(-4) : local
  const domainShort = domain.length > 18 ? domain.slice(0, 10) + '…' + domain.slice(-6) : domain
  return { primary: `${localShort}@${domainShort}`, full, isSynthetic: true }
}

export const AdminView: FC<{
  users: UserListRow[]
  records: DnsRecordRow[]
  settings: Settings
  inviteCodes: InviteCodeRow[]
  oauthProviders: OAuthProviderRow[]
  oauthTemplates?: OAuthTemplate[]
  currentUserId: string
  currentUserSuperAdmin: boolean
  activeTab?: AdminTab
  createError?: string
  inviteError?: string
  inviteInfo?: string
  oauthError?: string
  oauthInfo?: string
  csrfToken: string
  mailError?: string
  mailInfo?: string
}> = ({ users, records, settings, inviteCodes, oauthProviders, oauthTemplates = [], currentUserId, currentUserSuperAdmin, activeTab = 'settings', createError, inviteError, inviteInfo, oauthError, oauthInfo,
  csrfToken,
  mailError,
  mailInfo
}) => {
  const csrfField = (
    <input type="hidden" name="csrf_token" value={csrfToken} />
  )

  const tab = activeTab
  const tabClass = (id: AdminTab) =>
    tab === id
      ? 'flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg bg-emerald-500/10 text-emerald-400'
      : 'flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50 transition'

  return (
    <div class="min-h-screen bg-slate-950 flex flex-col md:flex-row text-slate-100">
      
      {/* Left Sidebar */}
      <aside class="w-full md:w-64 bg-slate-900 border-r border-slate-800 flex-shrink-0 flex flex-col sticky top-0 md:h-screen z-20">
        <div class="p-6">
          <div class="flex items-center gap-3 mb-8">
            <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold font-mono-custom text-base">
              A
            </div>
            <span class="font-bold text-white tracking-wide">管理员后台</span>
          </div>

          <nav class="space-y-1">
            <a href="/admin?tab=settings" class={tabClass('settings')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              </svg>
              全局设置
            </a>
            <a href="/admin?tab=oauth" class={tabClass('oauth')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zM6 19v-1a4 4 0 014-4h4a4 4 0 014 4v1" />
              </svg>
              OAuth 应用
            </a>
            <a href="/admin?tab=invites" class={tabClass('invites')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              邀请码
            </a>
            <a href="/admin?tab=users" class={tabClass('users')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              用户管理
            </a>
            <a href="/admin?tab=dns" class={tabClass('dns')}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              DNS 记录
            </a>
          </nav>
        </div>
        
        <div class="p-6 mt-auto border-t border-slate-800">
          <div class="flex flex-col gap-2">
            <a href="/" class="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              返回主页
            </a>
            <form method="post" action="/logout">
              <input type="hidden" name="csrf_token" value={csrfToken} />
              <button type="submit" class="flex items-center gap-2 text-sm text-rose-500/70 hover:text-rose-400 transition">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                退出登录
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main class="flex-grow p-6 md:p-10 max-w-6xl w-full mx-auto space-y-6">
        
        {/* Settings Tab */}
        {tab === 'settings' && (
        <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
          {(mailError || mailInfo) && (
            <div id="settings-mail-alert" class={`mb-4 p-3 rounded-lg text-sm border ${mailError ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'}`}>
              {mailError || mailInfo}
            </div>
          )}

          <h3 class="text-lg font-bold text-white mb-6 pb-3 border-b border-slate-800">全局与注册配置</h3>

          <form method="post" action="/admin/settings" class="space-y-6">
                {csrfField}

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* Left Column: Register settings */}
              <div class="space-y-5">
                <div class="flex items-center gap-3 bg-slate-950 p-4 rounded-md border border-slate-800">
                  <input 
                    type="checkbox" 
                    id="registration_enabled"
                    name="registration_enabled" 
                    checked={settings.registration_enabled} 
                    class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-900 border-slate-700"
                  />
                  <label for="registration_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">开启开放注册</label>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">注册通道模式</label>
                  <select 
                    name="registration_mode"
                    class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition cursor-pointer"
                  >
                    <option value="email" selected={settings.registration_mode === 'email'}>仅邮箱模式</option>
                    <option value="oauth" selected={settings.registration_mode === 'oauth'}>仅 OAuth 授权模式</option>
                    <option value="both" selected={settings.registration_mode === 'both'}>邮箱 + OAuth 双模式</option>
                  </select>
                </div>

                <div class="flex items-center gap-3 bg-slate-950 p-4 rounded-md border border-slate-800">
                  <input 
                    type="checkbox" 
                    id="invite_required"
                    name="invite_required" 
                    checked={settings.invite_required} 
                    class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-900 border-slate-700"
                  />
                  <label for="invite_required" class="text-sm font-medium text-slate-200 cursor-pointer">开启邀请码注册</label>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">GitHub 账号最短注册天数限制 (仅 provider_id=github)</label>
                  <input
                    type="number"
                    name="github_min_account_age_days"
                    value={settings.github_min_account_age_days}
                    min="0"
                    class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white focus:outline-none focus:border-emerald-500 transition font-mono-custom"
                    placeholder="0"
                  />
                  <span class="text-xs text-slate-500 mt-1 block">设置为 0 表示不限制。</span>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">每用户记录数量上限</label>
                  <input
                    type="number"
                    name="max_records_per_user"
                    value={settings.max_records_per_user}
                    min="0"
                    class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white focus:outline-none focus:border-emerald-500 transition font-mono-custom"
                    placeholder="5"
                  />
                  <span class="text-xs text-slate-500 mt-1 block">用户最多可创建的 DNS 记录条数；设为 0 表示不限。</span>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">子域名最小字符长度</label>
                  <input
                    type="number"
                    name="min_subdomain_length"
                    value={settings.min_subdomain_length}
                    min="0"
                    class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white focus:outline-none focus:border-emerald-500 transition font-mono-custom"
                    placeholder="0"
                  />
                  <span class="text-xs text-slate-500 mt-1 block">例如设置为 4 时，仅允许 1111.example.com 或更长子域名；设为 0 表示不限制。</span>
                </div>
              </div>

              {/* Right Column: Whitelist/Blacklist & Resend */}
              <div class="space-y-6">
                <div class="space-y-4">
                  <div class="bg-slate-950 p-4 rounded-md border border-slate-800">
                    <div class="flex items-center gap-3 mb-3">
                      <input 
                        type="checkbox" 
                        id="email_whitelist_enabled"
                        name="email_whitelist_enabled" 
                        checked={settings.email_whitelist_enabled} 
                        class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-900 border-slate-700"
                      />
                      <label for="email_whitelist_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱后缀白名单</label>
                    </div>
                    <input 
                      type="text" 
                      name="email_whitelist_suffixes" 
                      value={settings.email_whitelist_suffixes.join(',')} 
                      class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
                      placeholder="逗号分隔，如 gmail.com, 163.com"
                    />
                  </div>

                  <div class="bg-slate-950 p-4 rounded-md border border-slate-800">
                    <div class="flex items-center gap-3 mb-3">
                      <input 
                        type="checkbox" 
                        id="email_blacklist_enabled"
                        name="email_blacklist_enabled" 
                        checked={settings.email_blacklist_enabled} 
                        class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-900 border-slate-700"
                      />
                      <label for="email_blacklist_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱后缀黑名单</label>
                    </div>
                    <input 
                      type="text" 
                      name="email_blacklist_suffixes" 
                      value={settings.email_blacklist_suffixes.join(',')} 
                      class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
                      placeholder="逗号分隔，如 tempmail.com"
                    />
                  </div>
                </div>

                {/* Resend Service Panel */}
                <div class="bg-slate-950 p-5 rounded-md border border-slate-800">
                  <div class="flex items-start justify-between gap-3 mb-4">
                    <h4 class="text-sm font-bold text-white uppercase tracking-wider">邮件服务 (Resend HTTP API)</h4>
                    <button
                      type="button"
                      id="mail-test-open"
                      class="shrink-0 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition"
                      onclick="if(window.__adminMail){window.__adminMail.openMailTest(event)}else{var m=document.getElementById('mail-test-modal');if(m){m.classList.remove('hidden');document.body.style.overflow='hidden'}}"
                    >
                      测试发信
                    </button>
                  </div>

                  {(mailError || mailInfo) && (
                    <div class={`mb-4 p-3 rounded-md text-sm border ${mailError ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'}`}>
                      {mailError || mailInfo}
                    </div>
                  )}

                  <div class="flex items-center gap-3 mb-4">
                    <input
                      type="checkbox"
                      id="resend_enabled"
                      name="resend_enabled"
                      checked={settings.resend_enabled}
                      class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-900 border-slate-700"
                    />
                    <label for="resend_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱接收验证码注册</label>
                  </div>

                  <div class="space-y-4">
                    <input type="hidden" id="resend-account-froms" name="resend_account_froms" value={(settings.resend_accounts || []).map((a) => a.from).join('\n')} />
                    <input type="hidden" id="resend-account-keys" name="resend_account_keys" value={(settings.resend_accounts || []).map(() => '__KEEP__').join('\n')} />

                    <div>
                      <div class="flex items-center justify-between gap-2 mb-2">
                        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider">Resend API Key</label>
                        <button
                          type="button"
                          id="resend-accounts-open"
                          class="inline-flex items-center justify-center min-w-7 h-7 px-1.5 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm leading-none transition"
                          title="管理发件账号"
                          onclick="if(window.__adminMail){window.__adminMail.openAccounts(event)}else{var m=document.getElementById('resend-accounts-modal');if(m){m.classList.remove('hidden');document.body.style.overflow='hidden'}}"
                        >
                          +{(settings.resend_accounts?.length || 0) > 1 ? (
                            <span class="ml-0.5 text-[10px] text-emerald-400 font-semibold">{settings.resend_accounts.length}</span>
                          ) : null}
                        </button>
                      </div>
                      <input
                        type="password"
                        name="resend_api_key"
                        id="resend-primary-key"
                        placeholder={settings.resend_accounts?.[0]?.api_key ? '已配置（留空则不更新）' : 're_xxxxxxxx'}
                        class="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
                      />
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">发件人地址</label>
                      <input
                        type="email"
                        name="resend_from"
                        id="resend-primary-from"
                        value={settings.resend_accounts?.[0]?.from ?? ''}
                        placeholder="noreply@yourdomain.com"
                        class="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
                      />
                      <p class="mt-1.5 text-xs text-slate-500">默认显示第一组配置。点击右侧 + 可管理多个发件邮箱与对应 API Key。</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex justify-end pt-4">
              <button 
                type="submit" 
                class="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-md transition active:scale-[0.98]"
              >
                保存全局设置
              </button>
            </div>
          </form>
        </section>
        )}

        {/* OAuth Providers Section */}
        {tab === 'oauth' && (
        <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-lg font-bold text-white">OAuth 登录应用 ({oauthProviders.length})</h3>
          </div>

          {oauthError && (
            <div class="mb-4 p-3 rounded-md bg-rose-500/10 border border-rose-500/20 text-sm text-rose-400">{oauthError}</div>
          )}
          {oauthInfo && (
            <div class="mb-4 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">{oauthInfo}</div>
          )}

          <div class="mb-8 p-6 bg-slate-950 rounded-lg border border-slate-800">
            <h4 class="text-sm font-bold text-white mb-5">添加 OAuth 应用</h4>
            {oauthTemplates.length > 0 && (
              <div class="mb-6">
                <label class="block text-xs font-semibold text-slate-500 mb-2">常用模板（选择后自动填充表单）</label>
                <select
                  class="w-full md:w-80 px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500"
                  onchange={`
                    try {
                      const raw = this.options[this.selectedIndex].dataset.template || '';
                      if (!raw) return;
                      const t = JSON.parse(decodeURIComponent(raw));
                      const form = this.closest('div').nextElementSibling;
                      if (!form || form.tagName !== 'FORM') return;
                      const set = (name, val) => {
                        const el = form.querySelector('[name="' + name + '"]');
                        if (!el) return;
                        if (el.type === 'checkbox') el.checked = !!val;
                        else el.value = val == null ? '' : String(val);
                      };
                      set('provider_id', t.provider_id || '');
                      set('name', t.name || '');
                      set('discovery_url', t.discovery_url || '');
                      set('authorization_url', t.authorization_url || '');
                      set('token_url', t.token_url || '');
                      set('user_info_url', t.user_info_url || '');
                      set('scopes', t.scopes || 'openid,profile,email');
                      set('pkce', !!t.pkce);
                      set('icon_url', t.icon_url || '');
                    } catch (e) {}
                  `}
                >
                  <option value="">自定义 / 不使用模板</option>
                  {oauthTemplates.map((t) => (
                    <option value={t.id} data-template={encodeURIComponent(JSON.stringify(t))}>
                      {t.name} ({t.provider_id})
                    </option>
                  ))}
                </select>
                <p class="text-[11px] text-slate-500 mt-2">GitHub 模板会写入 <code>provider_id=github</code>，并保留账号天数限制逻辑。</p>
              </div>
            )}
            <form method="post" action="/admin/oauth/create" class="grid grid-cols-1 md:grid-cols-3 gap-4">
                {csrfField}

              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Provider ID</label>
                <input name="provider_id" required placeholder="github / linuxdo" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">显示名称</label>
                <input name="name" required placeholder="GitHub / Linux.do" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Client ID</label>
                <input name="client_id" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Client Secret</label>
                <input name="client_secret" required type="password" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div class="md:col-span-2">
                <label class="block text-xs font-semibold text-slate-500 mb-1">Discovery URL (推荐)</label>
                <input name="discovery_url" placeholder="https://issuer.example.com/.well-known/openid-configuration" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Authorization URL</label>
                <input name="authorization_url" placeholder="有 Discovery 时可留空" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Token URL</label>
                <input name="token_url" placeholder="有 Discovery 时可留空" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">UserInfo URL</label>
                <input name="user_info_url" placeholder="可选" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">Scopes</label>
                <input name="scopes" value="openid,profile,email" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">图标 URL</label>
                <input name="icon_url" placeholder="https://.../icon.svg" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">排序权重 (越小越靠前)</label>
                <input name="sort_order" type="number" value="0" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 font-mono-custom" />
              </div>
              <div class="md:col-span-3 flex flex-wrap items-center justify-between pt-2">
                <div class="flex gap-6">
                  <label class="inline-flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" name="pkce" checked class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" />
                    启用 PKCE
                  </label>
                  <label class="inline-flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" name="enabled" checked class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" />
                    立即启用
                  </label>
                </div>
                <button type="submit" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition">添加 OAuth</button>
              </div>
            </form>
            <div class="mt-4 p-3 bg-slate-900/50 rounded text-xs text-slate-500 border border-slate-800/50">
              <span class="font-bold text-slate-400">回调地址格式：</span> BETTER_AUTH_URL/api/auth/oauth2/callback/&lt;provider_id&gt;
            </div>
          </div>

          <div class="space-y-4">
            {oauthProviders.length === 0 ? (
              <div class="py-8 text-center text-slate-500 border border-dashed border-slate-800 rounded-lg">暂无 OAuth 应用</div>
            ) : (
              oauthProviders.map((p) => (
                <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
                  <div class="flex flex-wrap items-center justify-between p-4 gap-4">
                    <div class="flex items-center gap-4">
                      {p.icon_url ? (
                        <img src={p.icon_url} alt="" class="w-10 h-10 object-contain rounded-full bg-slate-900 border border-slate-800/50 p-1" />
                      ) : (
                        <div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 font-bold">
                          {p.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <div class="text-sm font-bold text-white flex items-center gap-2">
                          {p.name}
                          <span class={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold border ${p.enabled ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                            {p.enabled ? '已启用' : '已禁用'}
                          </span>
                        </div>
                        <div class="text-xs text-slate-500 font-mono-custom mt-1">{p.provider_id}</div>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <form method="post" action={`/admin/oauth/${p.id}/toggle`}>
                {csrfField}

                        <input type="hidden" name="enabled" value={p.enabled ? '0' : '1'} />
                        <button type="submit" class="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">
                          {p.enabled ? '禁用' : '启用'}
                        </button>
                      </form>
                      <button type="button" class="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition" onclick={`document.getElementById('edit-oauth-${p.id}').classList.toggle('hidden')`}>
                        编辑
                      </button>
                      <form method="post" action={`/admin/oauth/${p.id}/delete`} onsubmit="return confirm('确认删除该 OAuth 应用？');">
                {csrfField}

                        <button type="submit" class="px-3 py-1.5 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-md transition">删除</button>
                      </form>
                    </div>
                  </div>
                  
                  {/* Edit Form Dropdown */}
                  <div id={`edit-oauth-${p.id}`} class="hidden border-t border-slate-800 bg-slate-900/50 p-5">
                    <form method="post" action={`/admin/oauth/${p.id}/update`} class="grid grid-cols-1 md:grid-cols-3 gap-3">
                {csrfField}

                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Provider ID</label>
                        <input name="provider_id" value={p.provider_id} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">显示名称</label>
                        <input name="name" value={p.name} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Client ID</label>
                        <input name="client_id" value={p.client_id} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Client Secret</label>
                        <input name="client_secret" type="password" placeholder="留空则保留原密钥" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div class="md:col-span-2">
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Discovery URL</label>
                        <input name="discovery_url" value={p.discovery_url ?? ''} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Authorization URL</label>
                        <input name="authorization_url" value={p.authorization_url ?? ''} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Token URL</label>
                        <input name="token_url" value={p.token_url ?? ''} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">UserInfo URL</label>
                        <input name="user_info_url" value={p.user_info_url ?? ''} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Scopes</label>
                        <input name="scopes" value={p.scopes} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">图标 URL</label>
                        <input name="icon_url" value={p.icon_url ?? ''} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div>
                        <label class="block text-[10px] font-semibold text-slate-500 mb-1">Sort Order</label>
                        <input name="sort_order" type="number" value={p.sort_order} class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" />
                      </div>
                      <div class="md:col-span-3 flex items-center justify-between pt-2">
                        <div class="flex gap-4">
                          <label class="inline-flex items-center gap-2 text-xs text-slate-300">
                            <input type="checkbox" name="pkce" checked={!!p.pkce} class="w-3 h-3 rounded text-emerald-600 bg-slate-900 border-slate-700" /> PKCE
                          </label>
                          <label class="inline-flex items-center gap-2 text-xs text-slate-300">
                            <input type="checkbox" name="enabled" checked={!!p.enabled} class="w-3 h-3 rounded text-emerald-600 bg-slate-900 border-slate-700" /> 启用
                          </label>
                        </div>
                        <button type="submit" class="px-4 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition">保存修改</button>
                      </div>
                    </form>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        )}

        {/* Invites Tab */}
        {tab === 'invites' && (
        <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-lg font-bold text-white">邀请码管理 ({inviteCodes.length})</h3>
            <form method="post" action="/admin/invites/create">
                {csrfField}

              <button
                type="submit"
                disabled={!settings.invite_required}
                class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md transition active:scale-[0.98]"
              >
                生成邀请码
              </button>
            </form>
          </div>

          {!settings.invite_required && (
            <div class="mb-6 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-sm text-amber-400">
              请先在全局设置中开启邀请码注册功能，否则生成的邀请码将无法被使用。
            </div>
          )}

          {inviteError && (
            <div class="mb-4 p-3 rounded-md bg-rose-500/10 border border-rose-500/20 text-sm text-rose-400">{inviteError}</div>
          )}
          {inviteInfo && (
            <div class="mb-4 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">{inviteInfo}</div>
          )}

          <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-sm text-left border-collapse">
                <thead class="bg-slate-900/50">
                  <tr class="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    <th class="py-3 px-4">邀请码</th>
                    <th class="py-3 px-4">状态</th>
                    <th class="py-3 px-4">创建者</th>
                    <th class="py-3 px-4">使用者</th>
                    <th class="py-3 px-4">创建时间</th>
                    <th class="py-3 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  {inviteCodes.length === 0 ? (
                    <tr>
                      <td colspan={6} class="py-8 px-4 text-center text-slate-500">暂无邀请码</td>
                    </tr>
                  ) : (
                    inviteCodes.map((code) => {
                      const status = code.revoked ? '已作废' : code.used_by ? '已使用' : '未使用'
                      const statusClass = code.revoked
                        ? 'bg-slate-800 text-slate-400 border-slate-700'
                        : code.used_by
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                          : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      return (
                        <tr class="hover:bg-slate-900/40 transition">
                          <td class="py-3 px-4 font-mono-custom text-white tracking-wider">{code.code}</td>
                          <td class="py-3 px-4">
                            <span class={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${statusClass}`}>{status}</span>
                          </td>
                          <td class="py-3 px-4 text-slate-300 text-xs">
                            {code.creator_name || code.created_by}
                            {code.creator_email ? <div class="text-slate-500 truncate max-w-[10rem]" title={code.creator_email}>{formatEmailDisplay(code.creator_email).primary}</div> : null}
                          </td>
                          <td class="py-3 px-4 text-slate-300 text-xs">
                            {code.used_by ? (
                              <>
                                {code.used_name || code.used_by}
                                {code.used_email ? <div class="text-slate-500 truncate max-w-[10rem]" title={code.used_email}>{formatEmailDisplay(code.used_email).primary}</div> : null}
                              </>
                            ) : (
                              <span class="text-slate-600">-</span>
                            )}
                          </td>
                          <td class="py-3 px-4 text-slate-400 text-xs">{new Date(code.created_at).toLocaleString('zh-CN')}</td>
                          <td class="py-3 px-4 text-right">
                            {!code.used_by && !code.revoked ? (
                              <form method="post" action={`/admin/invites/${code.id}/revoke`} class="inline">
                {csrfField}

                                <button type="submit" class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">作废</button>
                              </form>
                            ) : (
                              <span class="text-xs text-slate-600">-</span>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
        )}

        {/* Users Tab */}
        {tab === 'users' && (
        <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-lg font-bold text-white">用户管理 ({users.length})</h3>
          </div>

          {createError && (
            <div class="mb-4 p-3 rounded-md bg-rose-500/10 border border-rose-500/20 text-sm text-rose-400">
              {createError}
            </div>
          )}

          <div class="mb-8 p-5 bg-slate-950 rounded-lg border border-slate-800">
            <h4 class="text-sm font-bold text-white mb-4">手动创建用户</h4>
            <form method="post" action="/admin/users/create" class="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                {csrfField}

              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">用户名</label>
                <input type="text" name="name" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="newuser" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">邮箱</label>
                <input type="email" name="email" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="user@example.com" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-500 mb-1">密码 (≥8位)</label>
                <input type="password" name="password" required minLength={8} class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="••••••••" />
              </div>
              <div class="flex gap-2">
                <div class="flex-grow">
                  <label class="block text-xs font-semibold text-slate-500 mb-1">角色</label>
                  <select name="role" disabled={!currentUserSuperAdmin} class="w-full px-2 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm focus:outline-none focus:border-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed">
                    <option value="user" selected>普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </div>
                <button type="submit" class="px-4 py-2 mt-5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-md transition active:scale-[0.98]">创建</button>
              </div>
            </form>
          </div>

          <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-sm text-left border-collapse">
                <thead class="bg-slate-900/50">
                  <tr class="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    <th class="py-3 px-4">用户名</th>
                    <th class="py-3 px-4">注册邮箱</th>
                    <th class="py-3 px-4">角色</th>
                    <th class="py-3 px-4">记录上限</th>
                    <th class="py-3 px-4">注册时间</th>
                    <th class="py-3 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  {users.map((u) => {
                    const isSuper = !!u.super_admin
                    const hasUnlimitedRecords = isSuper || u.role === 'admin'
                    return (
                    <tr class="hover:bg-slate-900/40 transition">
                      <td class="py-3 px-4 text-white font-medium">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span>{u.name}</span>
                          <span class="text-[10px] font-mono-custom text-slate-500">#{u.id}</span>
                          {u.id === currentUserId && (
                            <span class="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">你</span>
                          )}
                        </div>
                      </td>
                      <td class="py-3 px-4 font-mono-custom text-slate-300 max-w-[14rem]">
                        {(() => {
                          const e = formatEmailDisplay(u.email)
                          return (
                            <div class="min-w-0">
                              <div class="truncate text-xs" title={e.full}>{e.primary}</div>
                              {e.isSynthetic ? (
                                <div class="text-[10px] text-slate-500 mt-0.5 bg-slate-800/50 inline-block px-1 rounded">OAuth 合成</div>
                              ) : null}
                            </div>
                          )
                        })()}
                      </td>
                      <td class="py-3 px-4">
                        {isSuper ? (
                          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">超管</span>
                        ) : u.role === 'admin' ? (
                          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">管理员</span>
                        ) : (
                          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">用户</span>
                        )}
                      </td>
                      <td class="py-3 px-4 font-mono-custom text-slate-300 text-xs">
                        {hasUnlimitedRecords ? (
                          <span class="text-amber-400">∞</span>
                        ) : (
                          <form method="post" action={`/admin/users/${u.id}/limit`} class="flex items-center gap-1">
                {csrfField}

                            <input
                              type="number"
                              name="record_limit"
                              min="0"
                              value={u.record_limit === null || u.record_limit === undefined ? '' : u.record_limit}
                              placeholder={String(settings.max_records_per_user)}
                              class="w-16 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-white text-[11px] focus:outline-none focus:border-emerald-500 font-mono-custom"
                            />
                            <button type="submit" class="px-1.5 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded transition" title="留空跟随全局上限">修改</button>
                          </form>
                        )}
                      </td>
                      <td class="py-3 px-4 text-slate-400 text-[11px]">
                        {new Date(u.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                      </td>
                      <td class="py-3 px-4 text-right">
                        {u.id !== currentUserId && !isSuper && (currentUserSuperAdmin || u.role !== 'admin') && (
                          <div class="flex justify-end gap-1.5">
                            {currentUserSuperAdmin && (u.role !== 'admin' ? (
                              <form method="post" action={`/admin/users/${u.id}/role`} class="inline">
                {csrfField}

                                <input type="hidden" name="role" value="admin" />
                                <button type="submit" class="px-2 py-1 text-[11px] bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-900/30 rounded transition active:scale-[0.98]">
                                  设管理员
                                </button>
                              </form>
                            ) : (
                              <form method="post" action={`/admin/users/${u.id}/role`} class="inline">
                {csrfField}

                                <input type="hidden" name="role" value="user" />
                                <button type="submit" class="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded transition active:scale-[0.98]">
                                  降级
                                </button>
                              </form>
                            ))}
                            <form method="post" action={`/admin/users/${u.id}/delete`} class="inline" onsubmit="return confirm('确认删除该用户？将级联删除其所有 DNS 记录和关联会话！');">
                {csrfField}

                              <button type="submit" class="px-2 py-1 text-[11px] bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded transition active:scale-[0.98]">
                                删除
                              </button>
                            </form>
                          </div>
                        )}
                        {isSuper && (
                          <span class="text-[10px] text-amber-500/70 italic">受保护</span>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
        )}

        {/* DNS Records Section */}
        {tab === 'dns' && (
        <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-lg font-bold text-white">全局 DNS 记录 ({records.length})</h3>
          </div>

          <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-sm text-left border-collapse">
                <thead class="bg-slate-900/50">
                  <tr class="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    <th class="py-3 px-4">主机名</th>
                    <th class="py-3 px-4">目标服务器</th>
                    <th class="py-3 px-4">端口</th>
                    <th class="py-3 px-4">类型</th>
                    <th class="py-3 px-4">所有者 ID</th>
                    <th class="py-3 px-4">创建时间</th>
                    <th class="py-3 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  {records.map((r) => (
                    <tr class="hover:bg-slate-900/40 transition">
                      <td class="py-3 px-4 font-mono-custom text-emerald-400 break-all select-all cursor-pointer">{r.host_name}</td>
                      <td class="py-3 px-4 font-mono-custom text-slate-300 break-all">{r.server_address}</td>
                      <td class="py-3 px-4 font-mono-custom text-slate-300">{r.port}</td>
                      <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono-custom bg-slate-800 text-slate-300">{r.target_type}</span></td>
                      <td class="py-3 px-4 font-mono-custom text-slate-400 text-xs" title={r.user_id ?? ''}>{r.user_id ?? '系统'}</td>
                      <td class="py-3 px-4 text-slate-400 text-[11px]">{new Date(r.created_at).toLocaleString('zh-CN')}</td>
                      <td class="py-3 px-4 text-right">
                        <form method="post" action={`/admin/dns/${r.id}/delete`} class="inline" onsubmit="return confirm('确认删除？此操作将永久抹除 Cloudflare 中的解析数据！');">
                {csrfField}

                          <button type="submit" class="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-md transition active:scale-[0.98]">
                            强制删除
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={7} class="py-12 text-center text-slate-500">
                        目前系统里没有任何 DNS 解析记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
        )}

      
      <div id="resend-accounts-modal" class="hidden fixed inset-0 z-50">
        <div id="resend-accounts-backdrop" class="absolute inset-0 bg-black/70 backdrop-blur-[2px]"></div>
        <div class="relative z-10 min-h-full flex items-center justify-center p-4">
          <div class="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl shadow-black/50">
            <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div>
                <div class="text-base font-bold text-white">发件账号管理</div>
                <div class="text-xs text-slate-500 mt-1">按优先级配置多个发件邮箱与对应 API Key</div>
              </div>
              <button type="button" id="resend-accounts-close" class="px-2 py-1 text-slate-400 hover:text-white transition">×</button>
            </div>
            <div class="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              <div id="resend-accounts-list" class="space-y-3"></div>
              <button
                type="button"
                id="resend-account-add"
                class="w-full py-2.5 text-sm rounded-lg border border-dashed border-slate-700 text-slate-300 hover:bg-slate-900 hover:text-white transition"
              >+ 添加发件账号</button>
              <p class="text-xs text-slate-500">密钥留空表示保留原密钥。第一项会同步到主表单显示。</p>
            </div>
            <div class="flex justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button type="button" id="resend-accounts-cancel" class="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition">取消</button>
              <button type="button" id="resend-accounts-apply" class="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition">完成</button>
            </div>
          </div>
        </div>
      </div>

      <div id="mail-test-modal" class="hidden fixed inset-0 z-50">
        <div id="mail-test-backdrop" class="absolute inset-0 bg-black/70 backdrop-blur-[2px]"></div>
        <div class="relative z-10 min-h-full flex items-center justify-center p-4">
          <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl shadow-black/50">
            <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div>
                <div class="text-base font-bold text-white">测试发信</div>
                <div class="text-xs text-slate-500 mt-1">使用当前已保存的 Resend 配置发送测试邮件</div>
              </div>
              <button type="button" id="mail-test-close" class="px-2 py-1 text-slate-400 hover:text-white transition">×</button>
            </div>
            <form method="post" action="/admin/mail/test" class="px-5 py-4 space-y-4">
              {csrfField}
              <div>
                <label for="mail-test-to" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">接收邮箱</label>
                <input
                  id="mail-test-to"
                  type="email"
                  name="to_email"
                  required
                  placeholder="you@example.com"
                  class="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
                />
              </div>
              <div class="flex justify-end gap-2 pt-1">
                <button type="button" id="mail-test-cancel" class="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition">取消</button>
                <button type="submit" class="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition">发送</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <script src="/static/admin-mail.js" defer></script>
    </main>
    </div>
  )
}
