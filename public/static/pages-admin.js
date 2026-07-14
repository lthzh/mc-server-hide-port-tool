import {
  apiGet,
  apiMessage,
  apiPost,
  bindLogoutButtons,
  escapeAttr,
  escapeHtml,
  formatDate,
  formatEmailDisplay,
  mount,
  qs,
  showAppError,
  showToast
} from './app-core.js';

let state = null;

function tabClass(active, id) {
  return active === id
    ? 'flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg bg-emerald-500/10 text-emerald-400'
    : 'flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50 transition';
}

function alertBox(type, message) {
  if (!message) return '';
  const cls = type === 'error'
    ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300';
  return `<div class="mb-4 p-3 rounded-lg text-sm border ${cls}">${escapeHtml(message)}</div>`;
}

function renderSidebar(tab) {
  return `
  <aside class="w-full md:w-64 bg-slate-900 border-b md:border-b-0 md:border-r border-slate-800 flex-shrink-0 relative md:sticky md:top-0 md:h-screen z-20">
    <div class="flex items-center justify-between gap-3 px-4 py-3 md:px-6 md:py-6">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold font-mono-custom text-base shrink-0">A</div>
        <span class="font-bold text-white tracking-wide truncate">管理员后台</span>
      </div>
      <button type="button" id="admin-sidebar-toggle" class="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-white hover:border-slate-500 transition" aria-controls="admin-sidebar-panel" aria-expanded="false">
        <svg id="admin-sidebar-icon-open" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
        <svg id="admin-sidebar-icon-close" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
    <div id="admin-sidebar-panel" class="hidden md:flex flex-col md:h-[calc(100%-4.5rem)] border-t border-slate-800 md:border-t-0">
      <div class="p-4 md:p-6 md:pt-0 flex-1">
        <nav class="space-y-1">
          <a href="/admin?tab=settings" data-tab-link="settings" class="${tabClass(tab, 'settings')}">全局设置</a>
          <a href="/admin?tab=oauth" data-tab-link="oauth" class="${tabClass(tab, 'oauth')}">OAuth 应用</a>
          <a href="/admin?tab=invites" data-tab-link="invites" class="${tabClass(tab, 'invites')}">邀请码</a>
          <a href="/admin?tab=users" data-tab-link="users" class="${tabClass(tab, 'users')}">用户管理</a>
          <a href="/admin?tab=dns" data-tab-link="dns" class="${tabClass(tab, 'dns')}">DNS 记录</a>
        </nav>
      </div>
      <div class="p-4 md:p-6 mt-auto border-t border-slate-800">
        <div class="flex flex-col gap-2">
          <a href="/" class="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition">返回主页</a>
          <button type="button" data-action="logout" class="flex items-center gap-2 text-sm text-rose-500/70 hover:text-rose-400 transition text-left">退出登录</button>
        </div>
      </div>
    </div>
  </aside>`;
}

function renderSettingsTab(data) {
  const s = data.settings;
  const accounts = s.resend_accounts || [];
  return `
  <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
    <div id="settings-alert">${alertBox('error', data.mailError)}${alertBox('info', data.mailInfo)}</div>
    <h3 class="text-lg font-bold text-white mb-6 pb-3 border-b border-slate-800">全局与注册配置</h3>
    <form id="admin-settings-form" class="space-y-6">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="space-y-5">
          <label class="flex items-center gap-3 bg-slate-950 p-4 rounded-md border border-slate-800"><input type="checkbox" name="registration_enabled" ${s.registration_enabled ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" /><span class="text-sm font-medium text-slate-200">开启开放注册</span></label>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">注册通道模式</label>
            <select name="registration_mode" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white">
              <option value="email" ${s.registration_mode === 'email' ? 'selected' : ''}>仅邮箱模式</option>
              <option value="oauth" ${s.registration_mode === 'oauth' ? 'selected' : ''}>仅 OAuth 授权模式</option>
              <option value="both" ${s.registration_mode === 'both' ? 'selected' : ''}>邮箱 + OAuth 双模式</option>
            </select>
          </div>
          <label class="flex items-center gap-3 bg-slate-950 p-4 rounded-md border border-slate-800"><input type="checkbox" name="invite_required" ${s.invite_required ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" /><span class="text-sm font-medium text-slate-200">开启邀请码注册</span></label>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">GitHub 账号最短注册天数限制</label>
            <input type="number" name="github_min_account_age_days" value="${escapeAttr(String(s.github_min_account_age_days || 0))}" min="0" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white font-mono-custom" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">每用户记录数量上限</label>
            <input type="number" name="max_records_per_user" value="${escapeAttr(String(s.max_records_per_user || 0))}" min="0" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white font-mono-custom" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">子域名最小字符长度</label>
            <input type="number" name="min_subdomain_length" value="${escapeAttr(String(s.min_subdomain_length || 0))}" min="0" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white font-mono-custom" />
          </div>
        </div>
        <div class="space-y-6">
          <div class="bg-slate-950 p-4 rounded-md border border-slate-800">
            <label class="flex items-center gap-3 mb-3"><input type="checkbox" name="email_whitelist_enabled" ${s.email_whitelist_enabled ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" /><span class="text-sm font-medium text-slate-200">启用邮箱后缀白名单</span></label>
            <input type="text" name="email_whitelist_suffixes" value="${escapeAttr((s.email_whitelist_suffixes || []).join(','))}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm text-white" placeholder="gmail.com,163.com" />
          </div>
          <div class="bg-slate-950 p-4 rounded-md border border-slate-800">
            <label class="flex items-center gap-3 mb-3"><input type="checkbox" name="email_blacklist_enabled" ${s.email_blacklist_enabled ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" /><span class="text-sm font-medium text-slate-200">启用邮箱后缀黑名单</span></label>
            <input type="text" name="email_blacklist_suffixes" value="${escapeAttr((s.email_blacklist_suffixes || []).join(','))}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm text-white" placeholder="tempmail.com" />
          </div>
          <div class="bg-slate-950 p-5 rounded-md border border-slate-800">
            <div class="flex items-start justify-between gap-3 mb-4">
              <h4 class="text-sm font-bold text-white uppercase tracking-wider">邮件服务 (Resend HTTP API)</h4>
              <button type="button" id="mail-test-open" class="shrink-0 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-md transition">测试发信</button>
            </div>
            <label class="flex items-center gap-3 mb-4"><input type="checkbox" name="resend_enabled" ${s.resend_enabled ? 'checked' : ''} class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" /><span class="text-sm font-medium text-slate-200">启用邮箱接收验证码注册</span></label>
            <input type="hidden" id="resend-account-froms" name="resend_account_froms" value="${escapeAttr(accounts.map((a) => a.from).join('\n'))}" />
            <input type="hidden" id="resend-account-keys" name="resend_account_keys" value="${escapeAttr(accounts.map(() => '__KEEP__').join('\n'))}" />
            <div class="space-y-4">
              <div>
                <div class="flex items-center justify-between gap-2 mb-2">
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider">Resend API Key</label>
                  <button type="button" id="resend-accounts-open" class="inline-flex items-center justify-center min-w-7 h-7 px-1.5 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm leading-none transition" title="管理发件账号">+${accounts.length > 1 ? `<span class="ml-0.5 text-[10px] text-emerald-400 font-semibold">${accounts.length}</span>` : ''}</button>
                </div>
                <input type="password" name="resend_api_key" id="resend-primary-key" placeholder="${accounts[0]?.has_key ? '已配置（留空则不更新）' : 're_xxxxxxxx'}" class="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-md text-white" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">发件人地址</label>
                <input type="email" name="resend_from" id="resend-primary-from" value="${escapeAttr(accounts[0]?.from || '')}" placeholder="noreply@yourdomain.com" class="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-md text-white" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="flex justify-end pt-4">
        <button type="submit" class="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-md transition">保存全局设置</button>
      </div>
    </form>
  </section>
  <div id="resend-accounts-modal" class="hidden fixed inset-0 z-50">
    <div id="resend-accounts-backdrop" class="absolute inset-0 bg-black/70 backdrop-blur-[2px]"></div>
    <div class="relative z-10 min-h-full flex items-center justify-center p-4">
      <div class="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl shadow-black/50">
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div><div class="text-base font-bold text-white">发件账号管理</div><div class="text-xs text-slate-500 mt-1">按优先级配置多个发件邮箱与对应 API Key</div></div>
          <button type="button" id="resend-accounts-close" class="px-2 py-1 text-slate-400 hover:text-white transition">×</button>
        </div>
        <div class="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div id="resend-accounts-list" class="space-y-3"></div>
          <button type="button" id="resend-account-add" class="w-full py-2.5 text-sm rounded-lg border border-dashed border-slate-700 text-slate-300 hover:bg-slate-900 hover:text-white transition">+ 添加发件账号</button>
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
          <div><div class="text-base font-bold text-white">测试发信</div><div class="text-xs text-slate-500 mt-1">使用当前已保存的 Resend 配置发送测试邮件</div></div>
          <button type="button" id="mail-test-close" class="px-2 py-1 text-slate-400 hover:text-white transition">×</button>
        </div>
        <form id="mail-test-form" class="px-5 py-4 space-y-4">
          <div>
            <label for="mail-test-to" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">接收邮箱</label>
            <input id="mail-test-to" type="email" name="to_email" required placeholder="you@example.com" class="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white" />
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button type="button" id="mail-test-cancel" class="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition">取消</button>
            <button type="submit" class="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition">发送</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function renderOAuthTab(data) {
  const providers = data.oauthProviders || [];
  const templates = data.oauthTemplates || [];
  return `
  <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
    <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800"><h3 class="text-lg font-bold text-white">OAuth 登录应用 (${providers.length})</h3></div>
    <div id="oauth-alert">${alertBox('error', data.oauthError)}${alertBox('info', data.oauthInfo)}</div>
    <div class="mb-8 p-6 bg-slate-950 rounded-lg border border-slate-800">
      <h4 class="text-sm font-bold text-white mb-5">添加 OAuth 应用</h4>
      ${templates.length ? `<div class="mb-6"><label class="block text-xs font-semibold text-slate-500 mb-2">常用模板</label>
        <select id="oauth-template-select" class="w-full md:w-80 px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm">
          <option value="">自定义 / 不使用模板</option>
          ${templates.map((t) => `<option value="${escapeAttr(t.id)}" data-template="${escapeAttr(encodeURIComponent(JSON.stringify(t)))}">${escapeHtml(t.name)} (${escapeHtml(t.provider_id)})</option>`).join('')}
        </select></div>` : ''}
      <form id="oauth-create-form" class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Provider ID</label><input name="provider_id" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">显示名称</label><input name="name" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Client ID</label><input name="client_id" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Client Secret</label><input name="client_secret" required type="password" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div class="md:col-span-2"><label class="block text-xs font-semibold text-slate-500 mb-1">Discovery URL</label><input name="discovery_url" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Authorization URL</label><input name="authorization_url" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Token URL</label><input name="token_url" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">UserInfo URL</label><input name="user_info_url" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">Scopes</label><input name="scopes" value="openid,profile,email" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">图标 URL</label><input name="icon_url" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">排序权重</label><input name="sort_order" type="number" value="0" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" /></div>
        <div class="md:col-span-3 flex flex-wrap items-center justify-between pt-2">
          <div class="flex gap-6">
            <label class="inline-flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" name="pkce" checked class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" />启用 PKCE</label>
            <label class="inline-flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" name="enabled" checked class="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700" />立即启用</label>
          </div>
          <button type="submit" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition">添加 OAuth</button>
        </div>
      </form>
      <div class="mt-4 p-3 bg-slate-900/50 rounded text-xs text-slate-500 border border-slate-800/50"><span class="font-bold text-slate-400">回调地址格式：</span> BETTER_AUTH_URL/api/auth/oauth2/callback/&lt;provider_id&gt;</div>
    </div>
    <div class="space-y-4">
      ${providers.length === 0 ? '<div class="py-8 text-center text-slate-500 border border-dashed border-slate-800 rounded-lg">暂无 OAuth 应用</div>' : providers.map((p) => `
        <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
          <div class="flex flex-wrap items-center justify-between p-4 gap-3">
            <div class="flex items-center gap-4">
              ${p.icon_url ? `<img src="${escapeAttr(p.icon_url)}" alt="" class="w-10 h-10 object-contain rounded-full bg-slate-900 border border-slate-800/50 p-1" />` : `<div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 font-bold">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div>`}
              <div>
                <div class="text-sm font-bold text-white flex items-center gap-2">${escapeHtml(p.name)}
                  <span class="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold border ${p.enabled ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-400 border-slate-700'}">${p.enabled ? '已启用' : '已禁用'}</span>
                </div>
                <div class="text-xs text-slate-500 font-mono-custom mt-1">${escapeHtml(p.provider_id)}</div>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-nowrap shrink-0">
              <button type="button" data-oauth-toggle="${escapeAttr(p.id)}" data-enabled="${p.enabled ? '0' : '1'}" class="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">${p.enabled ? '禁用' : '启用'}</button>
              <button type="button" data-oauth-edit="${escapeAttr(p.id)}" class="inline-flex items-center px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">编辑</button>
              <button type="button" data-oauth-delete="${escapeAttr(p.id)}" class="inline-flex items-center px-3 py-1.5 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-md transition">删除</button>
            </div>
          </div>
          <div id="edit-oauth-${escapeAttr(p.id)}" class="hidden border-t border-slate-800 bg-slate-900/50 p-5">
            <form data-oauth-update="${escapeAttr(p.id)}" class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Provider ID</label><input name="provider_id" value="${escapeAttr(p.provider_id)}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">显示名称</label><input name="name" value="${escapeAttr(p.name)}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Client ID</label><input name="client_id" value="${escapeAttr(p.client_id)}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Client Secret</label><input name="client_secret" type="password" placeholder="留空则保留原密钥" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div class="md:col-span-2"><label class="block text-[10px] font-semibold text-slate-500 mb-1">Discovery URL</label><input name="discovery_url" value="${escapeAttr(p.discovery_url || '')}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Authorization URL</label><input name="authorization_url" value="${escapeAttr(p.authorization_url || '')}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Token URL</label><input name="token_url" value="${escapeAttr(p.token_url || '')}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">UserInfo URL</label><input name="user_info_url" value="${escapeAttr(p.user_info_url || '')}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Scopes</label><input name="scopes" value="${escapeAttr(p.scopes)}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">图标 URL</label><input name="icon_url" value="${escapeAttr(p.icon_url || '')}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div><label class="block text-[10px] font-semibold text-slate-500 mb-1">Sort Order</label><input name="sort_order" type="number" value="${escapeAttr(String(p.sort_order || 0))}" class="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono-custom" /></div>
              <div class="md:col-span-3 flex items-center justify-between pt-2">
                <div class="flex gap-4">
                  <label class="inline-flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" name="pkce" ${p.pkce ? 'checked' : ''} class="w-3 h-3 rounded text-emerald-600 bg-slate-900 border-slate-700" /> PKCE</label>
                  <label class="inline-flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''} class="w-3 h-3 rounded text-emerald-600 bg-slate-900 border-slate-700" /> 启用</label>
                </div>
                <button type="submit" class="px-4 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition">保存修改</button>
              </div>
            </form>
          </div>
        </div>`).join('')}
    </div>
  </section>`;
}

function renderInvitesTab(data) {
  const codes = data.inviteCodes || [];
  const s = data.settings || {};
  return `
  <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
    <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
      <h3 class="text-lg font-bold text-white">邀请码管理 (${codes.length})</h3>
      <button type="button" id="invite-create-btn" ${s.invite_required ? '' : 'disabled'} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md transition">生成邀请码</button>
    </div>
    ${!s.invite_required ? '<div class="mb-6 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-sm text-amber-400">请先在全局设置中开启邀请码注册功能，否则生成的邀请码将无法被使用。</div>' : ''}
    <div id="invite-alert">${alertBox('error', data.inviteError)}${alertBox('info', data.inviteInfo)}</div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left border-collapse">
          <thead class="bg-slate-900/50">
            <tr class="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              <th class="py-3 px-4">邀请码</th><th class="py-3 px-4">状态</th><th class="py-3 px-4">创建者</th><th class="py-3 px-4">使用者</th><th class="py-3 px-4">创建时间</th><th class="py-3 px-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/60">
            ${codes.length === 0 ? '<tr><td colspan="6" class="py-8 px-4 text-center text-slate-500">暂无邀请码</td></tr>' : codes.map((code) => {
              const status = code.revoked ? '已作废' : code.used_by ? '已使用' : '未使用';
              const statusClass = code.revoked ? 'bg-slate-800 text-slate-400 border-slate-700' : code.used_by ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
              const creatorEmail = code.creator_email ? formatEmailDisplay(code.creator_email).primary : '';
              const usedEmail = code.used_email ? formatEmailDisplay(code.used_email).primary : '';
              return `<tr class="hover:bg-slate-900/40 transition">
                <td class="py-3 px-4 font-mono-custom text-white tracking-wider">${escapeHtml(code.code)}</td>
                <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-md text-[11px] font-semibold border ${statusClass}">${status}</span></td>
                <td class="py-3 px-4 text-slate-300 text-xs">${escapeHtml(code.creator_name || code.created_by || '')}${creatorEmail ? `<div class="text-slate-500 truncate max-w-[10rem]" title="${escapeAttr(code.creator_email)}">${escapeHtml(creatorEmail)}</div>` : ''}</td>
                <td class="py-3 px-4 text-slate-300 text-xs">${code.used_by ? `${escapeHtml(code.used_name || code.used_by)}${usedEmail ? `<div class="text-slate-500 truncate max-w-[10rem]" title="${escapeAttr(code.used_email)}">${escapeHtml(usedEmail)}</div>` : ''}` : '<span class="text-slate-600">-</span>'}</td>
                <td class="py-3 px-4 text-slate-400 text-xs">${escapeHtml(formatDate(code.created_at))}</td>
                <td class="py-3 px-4 text-right">${!code.used_by && !code.revoked ? `<button type="button" data-invite-revoke="${escapeAttr(code.id)}" class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">作废</button>` : '<span class="text-xs text-slate-600">-</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderUsersTab(data) {
  const users = data.users || [];
  const s = data.settings || {};
  const currentUserId = data.currentUserId;
  const isSuper = !!data.currentUserSuperAdmin;
  const query = data.usersQuery || { q: '', role: 'all' };
  const q = query.q || '';
  const role = query.role || 'all';
  return `
  <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-3 border-b border-slate-800">
      <h3 class="text-lg font-bold text-white">用户管理 (${users.length})</h3>
      <p class="text-xs text-slate-500">邮箱已脱敏显示；搜索时请输入完整邮箱，后端按明文匹配后返回脱敏结果。</p>
    </div>
    <div id="users-alert">${alertBox('error', data.createError)}</div>

    <form id="user-search-form" class="mb-6 p-4 bg-slate-950 rounded-lg border border-slate-800 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
      <div class="md:col-span-2">
        <label class="block text-xs font-semibold text-slate-500 mb-1">搜索</label>
        <input type="text" name="q" value="${escapeAttr(q)}" placeholder="完整邮箱 / 用户名 / 用户 ID" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm font-mono-custom" />
      </div>
      <div>
        <label class="block text-xs font-semibold text-slate-500 mb-1">角色筛选</label>
        <select name="role" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm">
          <option value="all" ${role === 'all' ? 'selected' : ''}>全部</option>
          <option value="user" ${role === 'user' ? 'selected' : ''}>普通用户</option>
          <option value="admin" ${role === 'admin' ? 'selected' : ''}>管理员</option>
          <option value="super" ${role === 'super' ? 'selected' : ''}>超级管理员</option>
        </select>
      </div>
      <div class="flex gap-2">
        <button type="submit" class="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-md transition">搜索</button>
        <button type="button" id="user-search-reset" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm rounded-md border border-slate-700 transition">重置</button>
      </div>
    </form>

    <div class="mb-8 p-5 bg-slate-950 rounded-lg border border-slate-800">
      <h4 class="text-sm font-bold text-white mb-4">手动创建用户</h4>
      <form id="user-create-form" class="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">用户名</label><input type="text" name="name" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">邮箱</label><input type="email" name="email" required class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm" /></div>
        <div><label class="block text-xs font-semibold text-slate-500 mb-1">密码 (≥8位)</label><input type="password" name="password" required minlength="8" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm" /></div>
        <div class="flex gap-2">
          <div class="flex-grow"><label class="block text-xs font-semibold text-slate-500 mb-1">角色</label>
            <select name="role" ${isSuper ? '' : 'disabled'} class="w-full px-2 py-2 bg-slate-900 border border-slate-800 rounded-md text-white text-sm disabled:opacity-60">
              <option value="user" selected>普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <button type="submit" class="px-4 py-2 mt-5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-md transition">创建</button>
        </div>
      </form>
    </div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left border-collapse">
          <thead class="bg-slate-900/50">
            <tr class="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th class="py-3 px-4">用户名</th><th class="py-3 px-4">注册邮箱（脱敏）</th><th class="py-3 px-4">角色</th><th class="py-3 px-4">记录上限</th><th class="py-3 px-4">注册时间</th><th class="py-3 px-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/60">
            ${users.length === 0 ? '<tr><td colspan="6" class="py-10 text-center text-slate-500 text-sm">没有匹配的用户</td></tr>' : users.map((u) => {
              const isUserSuper = !!u.super_admin;
              const unlimited = isUserSuper || u.role === 'admin';
              // Backend already force-masks email; do not re-expand or expose full address.
              const email = u.email || '';
              return `<tr class="hover:bg-slate-900/40 transition">
                <td class="py-3 px-4 text-white font-medium"><div class="flex items-center gap-2 flex-wrap"><span>${escapeHtml(u.name)}</span><span class="text-[10px] font-mono-custom text-slate-500">#${escapeHtml(u.id)}</span>${u.id === currentUserId ? '<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">你</span>' : ''}</div></td>
                <td class="py-3 px-4 font-mono-custom text-slate-300 max-w-[14rem]"><div class="min-w-0"><div class="truncate text-xs" title="${escapeAttr(email)}">${escapeHtml(email)}</div></div></td>
                <td class="py-3 px-4">${isUserSuper ? '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">超管</span>' : u.role === 'admin' ? '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">管理员</span>' : '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">用户</span>'}</td>
                <td class="py-3 px-4 font-mono-custom text-slate-300 text-xs">${unlimited ? '<span class="text-amber-400">∞</span>' : `<form data-user-limit="${escapeAttr(u.id)}" class="flex items-center gap-1"><input type="number" name="record_limit" min="0" value="${u.record_limit == null ? '' : escapeAttr(String(u.record_limit))}" placeholder="${escapeAttr(String(s.max_records_per_user || 0))}" class="w-16 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-white text-[11px] font-mono-custom" /><button type="submit" class="px-1.5 py-1 text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded transition">修改</button></form>`}</td>
                <td class="py-3 px-4 text-slate-400 text-[11px]">${escapeHtml(formatDate(u.createdAt))}</td>
                <td class="py-3 px-4 text-right">${u.id !== currentUserId && !isUserSuper && (isSuper || u.role !== 'admin') ? `<div class="flex justify-end gap-1.5">
                  ${isSuper ? (u.role !== 'admin' ? `<button type="button" data-user-role="${escapeAttr(u.id)}" data-role="admin" class="px-2 py-1 text-[11px] bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-900/30 rounded transition">设管理员</button>` : `<button type="button" data-user-role="${escapeAttr(u.id)}" data-role="user" class="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded transition">降级</button>`) : ''}
                  <button type="button" data-user-delete="${escapeAttr(u.id)}" class="px-2 py-1 text-[11px] bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded transition">删除</button>
                </div>` : (isUserSuper ? '<span class="text-[10px] text-amber-500/70 italic">受保护</span>' : '')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderDnsTab(data) {
  const records = data.records || [];
  return `
  <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
    <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800"><h3 class="text-lg font-bold text-white">全局 DNS 记录 (${records.length})</h3></div>
    <div class="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left border-collapse">
          <thead class="bg-slate-900/50">
            <tr class="border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th class="py-3 px-4">主机名</th><th class="py-3 px-4">目标服务器</th><th class="py-3 px-4">端口</th><th class="py-3 px-4">类型</th><th class="py-3 px-4">所有者 ID</th><th class="py-3 px-4">创建时间</th><th class="py-3 px-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/60">
            ${records.length === 0 ? '<tr><td colspan="7" class="py-12 text-center text-slate-500">目前系统里没有任何 DNS 解析记录</td></tr>' : records.map((r) => `
              <tr class="hover:bg-slate-900/40 transition">
                <td class="py-3 px-4 font-mono-custom text-emerald-400 break-all">${escapeHtml(r.host_name)}</td>
                <td class="py-3 px-4 font-mono-custom text-slate-300 break-all">${escapeHtml(r.server_address)}</td>
                <td class="py-3 px-4 font-mono-custom text-slate-300">${escapeHtml(String(r.port))}</td>
                <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono-custom bg-slate-800 text-slate-300">${escapeHtml(r.target_type)}</span></td>
                <td class="py-3 px-4 font-mono-custom text-slate-400 text-xs">${escapeHtml(r.user_id || '系统')}</td>
                <td class="py-3 px-4 text-slate-400 text-[11px]">${escapeHtml(formatDate(r.created_at))}</td>
                <td class="py-3 px-4 text-right"><button type="button" data-dns-delete="${escapeAttr(r.id)}" class="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-md transition">强制删除</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function formToObject(form) {
  const fd = new FormData(form);
  const obj = {};
  for (const [k, v] of fd.entries()) obj[k] = v;
  form.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    obj[el.name] = el.checked;
  });
  return obj;
}

function setTab(tab) {
  const url = new URL(window.location.href);
  if (tab && tab !== 'settings') url.searchParams.set('tab', tab);
  else url.searchParams.delete('tab');
  window.history.replaceState({}, '', url.toString());
}

async function loadAdmin(tab, flash = {}) {
  const active = tab || (state && state.activeTab) || 'settings';
  const params = new URLSearchParams();
  params.set('tab', active);
  if (active === 'users') {
    const q = (flash.usersQuery && flash.usersQuery.q != null)
      ? flash.usersQuery.q
      : (state && state.usersQuery && state.usersQuery.q) || '';
    const role = (flash.usersQuery && flash.usersQuery.role)
      ? flash.usersQuery.role
      : (state && state.usersQuery && state.usersQuery.role) || 'all';
    if (q) params.set('q', q);
    if (role && role !== 'all') params.set('role', role);
  }
  const { res, data } = await apiGet(`/api/pages/admin?${params.toString()}`);
  if (data?.redirect) { window.location.href = data.redirect; return; }
  if (!res.ok || !data?.success) { showAppError(apiMessage(data, '管理后台加载失败')); return; }
  state = {
    ...data.data,
    ...flash,
    activeTab: active || data.data.activeTab || 'settings',
    usersQuery: data.data.usersQuery || flash.usersQuery || { q: '', role: 'all' }
  };
  renderAll();
}

function renderAll() {
  const tab = state.activeTab || 'settings';
  let body = '';
  if (tab === 'settings') body = renderSettingsTab(state);
  else if (tab === 'oauth') body = renderOAuthTab(state);
  else if (tab === 'invites') body = renderInvitesTab(state);
  else if (tab === 'users') body = renderUsersTab(state);
  else body = renderDnsTab(state);

  mount(`
    <div class="min-h-screen bg-slate-950 flex flex-col md:flex-row text-slate-100">
      ${renderSidebar(tab)}
      <main class="flex-grow p-4 sm:p-6 md:p-10 max-w-6xl w-full mx-auto space-y-6 min-w-0">${body}</main>
    </div>
  `);
  bindEvents();
}

function bindSidebar() {
  bindLogoutButtons();
  document.querySelectorAll('[data-tab-link]').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const tab = a.getAttribute('data-tab-link');
      setTab(tab);
      await loadAdmin(tab);
    });
  });
  const toggle = document.getElementById('admin-sidebar-toggle');
  const panel = document.getElementById('admin-sidebar-panel');
  const iconOpen = document.getElementById('admin-sidebar-icon-open');
  const iconClose = document.getElementById('admin-sidebar-icon-close');
  if (toggle && panel) {
    const setOpen = (open) => {
      if (open) { panel.classList.remove('hidden'); panel.classList.add('flex'); }
      else { panel.classList.add('hidden'); panel.classList.remove('flex'); }
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (iconOpen) iconOpen.classList.toggle('hidden', open);
      if (iconClose) iconClose.classList.toggle('hidden', !open);
    };
    setOpen(false);
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    window.addEventListener('resize', () => {
      if (window.matchMedia('(min-width: 768px)').matches) {
        panel.classList.remove('hidden'); panel.classList.add('flex');
        toggle.setAttribute('aria-expanded', 'false');
        if (iconOpen) iconOpen.classList.remove('hidden');
        if (iconClose) iconClose.classList.add('hidden');
      } else if (toggle.getAttribute('aria-expanded') !== 'true') setOpen(false);
    });
  }
}

function bindMailHelpers() {
  // Reuse existing admin-mail.js globals if present; otherwise simple modal open/close.
  if (window.__adminMail) return;
  const open = (id) => { const m = document.getElementById(id); if (m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; } };
  const close = (id) => { const m = document.getElementById(id); if (m) { m.classList.add('hidden'); document.body.style.overflow = ''; } };
  document.getElementById('mail-test-open')?.addEventListener('click', (e) => { e.preventDefault(); open('mail-test-modal'); });
  document.getElementById('resend-accounts-open')?.addEventListener('click', (e) => { e.preventDefault(); open('resend-accounts-modal'); });
  ['mail-test-close','mail-test-cancel','mail-test-backdrop'].forEach((id) => document.getElementById(id)?.addEventListener('click', (e) => { e.preventDefault(); close('mail-test-modal'); }));
  ['resend-accounts-close','resend-accounts-cancel','resend-accounts-backdrop'].forEach((id) => document.getElementById(id)?.addEventListener('click', (e) => { e.preventDefault(); close('resend-accounts-modal'); }));
}

function bindEvents() {
  bindSidebar();
  bindMailHelpers();
  // ensure admin-mail script hooks after DOM ready
  if (window.__adminMail) {
    // already available
  } else {
    // dynamically load classic admin-mail.js once
    if (!document.querySelector('script[data-admin-mail]')) {
      const s = document.createElement('script');
      s.src = '/static/admin-mail.js';
      s.defer = true;
      s.dataset.adminMail = '1';
      document.body.appendChild(s);
    }
  }

  document.getElementById('admin-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const obj = formToObject(e.currentTarget);
    const payload = {
      registration_enabled: !!obj.registration_enabled,
      registration_mode: String(obj.registration_mode || 'email'),
      invite_required: !!obj.invite_required,
      email_whitelist_enabled: !!obj.email_whitelist_enabled,
      email_whitelist_suffixes: String(obj.email_whitelist_suffixes || ''),
      email_blacklist_enabled: !!obj.email_blacklist_enabled,
      email_blacklist_suffixes: String(obj.email_blacklist_suffixes || ''),
      github_min_account_age_days: Number(obj.github_min_account_age_days || 0),
      max_records_per_user: Number(obj.max_records_per_user || 0),
      min_subdomain_length: Number(obj.min_subdomain_length || 0),
      resend_enabled: !!obj.resend_enabled,
      resend_api_key: String(obj.resend_api_key || ''),
      resend_from: String(obj.resend_from || ''),
      resend_account_froms: String(obj.resend_account_froms || ''),
      resend_account_keys: String(obj.resend_account_keys || '')
    };
    const { data } = await apiPost('/api/admin/settings', payload);
    if (data?.success) {
      showToast(data.message || '设置已保存', 'success');
      await loadAdmin('settings', { mailInfo: data.message || '设置已保存' });
    } else {
      await loadAdmin('settings', { mailError: apiMessage(data, '保存失败') });
    }
  });

  document.getElementById('mail-test-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const { data } = await apiPost('/api/admin/mail/test', { to_email: String(fd.get('to_email') || '') });
    await loadAdmin('settings', data?.success ? { mailInfo: data.message || '测试邮件已发送' } : { mailError: apiMessage(data, '测试发信失败') });
  });

  document.getElementById('oauth-template-select')?.addEventListener('change', (e) => {
    const opt = e.currentTarget.options[e.currentTarget.selectedIndex];
    const raw = opt?.dataset?.template || '';
    if (!raw) return;
    try {
      const t = JSON.parse(decodeURIComponent(raw));
      const form = document.getElementById('oauth-create-form');
      if (!form) return;
      const set = (name, val) => {
        const el = form.querySelector(`[name="${name}"]`);
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
    } catch {}
  });

  document.getElementById('oauth-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const obj = formToObject(e.currentTarget);
    const { data } = await apiPost('/api/admin/oauth/create', {
      ...obj,
      pkce: !!obj.pkce,
      enabled: !!obj.enabled,
      sort_order: Number(obj.sort_order || 0)
    });
    await loadAdmin('oauth', data?.success ? { oauthInfo: data.message || '已添加' } : { oauthError: apiMessage(data, '添加失败') });
  });

  document.querySelectorAll('[data-oauth-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    const { data } = await apiPost(`/api/admin/oauth/${btn.getAttribute('data-oauth-toggle')}/toggle`, { enabled: btn.getAttribute('data-enabled') === '1' });
    await loadAdmin('oauth', data?.success ? { oauthInfo: data.message || '已更新' } : { oauthError: apiMessage(data, '操作失败') });
  }));
  document.querySelectorAll('[data-oauth-edit]').forEach((btn) => btn.addEventListener('click', () => {
    document.getElementById(`edit-oauth-${btn.getAttribute('data-oauth-edit')}`)?.classList.toggle('hidden');
  }));
  document.querySelectorAll('[data-oauth-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('确认删除该 OAuth 应用？')) return;
    const { data } = await apiPost(`/api/admin/oauth/${btn.getAttribute('data-oauth-delete')}/delete`, {});
    await loadAdmin('oauth', data?.success ? { oauthInfo: data.message || '已删除' } : { oauthError: apiMessage(data, '删除失败') });
  }));
  document.querySelectorAll('form[data-oauth-update]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = form.getAttribute('data-oauth-update');
    const obj = formToObject(form);
    const { data } = await apiPost(`/api/admin/oauth/${id}/update`, {
      ...obj,
      pkce: !!obj.pkce,
      enabled: !!obj.enabled,
      sort_order: Number(obj.sort_order || 0)
    });
    await loadAdmin('oauth', data?.success ? { oauthInfo: data.message || '已更新' } : { oauthError: apiMessage(data, '更新失败') });
  }));

  document.getElementById('invite-create-btn')?.addEventListener('click', async () => {
    const { data } = await apiPost('/api/admin/invites/create', {});
    await loadAdmin('invites', data?.success ? { inviteInfo: data.message || '已创建' } : { inviteError: apiMessage(data, '创建失败') });
  });
  document.querySelectorAll('[data-invite-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
    const { data } = await apiPost(`/api/admin/invites/${btn.getAttribute('data-invite-revoke')}/revoke`, {});
    await loadAdmin('invites', data?.success ? { inviteInfo: data.message || '已作废' } : { inviteError: apiMessage(data, '操作失败') });
  }));

  document.getElementById('user-search-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const obj = formToObject(e.currentTarget);
    await loadAdmin('users', {
      usersQuery: {
        q: String(obj.q || '').trim(),
        role: String(obj.role || 'all')
      }
    });
  });
  document.getElementById('user-search-reset')?.addEventListener('click', async () => {
    await loadAdmin('users', { usersQuery: { q: '', role: 'all' } });
  });
  document.getElementById('user-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const obj = formToObject(e.currentTarget);
    const { data } = await apiPost('/api/admin/users/create', obj);
    await loadAdmin('users', data?.success ? {} : { createError: apiMessage(data, '创建失败') });
  });
  document.querySelectorAll('form[data-user-limit]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = form.getAttribute('data-user-limit');
    const obj = formToObject(form);
    const { data } = await apiPost(`/api/admin/users/${id}/limit`, { record_limit: obj.record_limit });
    if (!data?.success) showToast(apiMessage(data, '修改失败'), 'error');
    else await loadAdmin('users');
  }));
  document.querySelectorAll('[data-user-role]').forEach((btn) => btn.addEventListener('click', async () => {
    const { data } = await apiPost(`/api/admin/users/${btn.getAttribute('data-user-role')}/role`, { role: btn.getAttribute('data-role') });
    if (!data?.success) showToast(apiMessage(data, '操作失败'), 'error');
    else await loadAdmin('users');
  }));
  document.querySelectorAll('[data-user-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('确认删除该用户？将级联删除其所有 DNS 记录和关联会话！')) return;
    const { data } = await apiPost(`/api/admin/users/${btn.getAttribute('data-user-delete')}/delete`, {});
    if (!data?.success) showToast(apiMessage(data, '删除失败'), 'error');
    else await loadAdmin('users');
  }));

  document.querySelectorAll('[data-dns-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('确认删除？此操作将永久抹除 Cloudflare 中的解析数据！')) return;
    const { data } = await apiPost(`/api/admin/dns/${btn.getAttribute('data-dns-delete')}/delete`, {});
    if (!data?.success) showToast(apiMessage(data, '删除失败'), 'error');
    else await loadAdmin('dns');
  }));
}

async function boot() {
  const tab = qs('tab', 'settings') || 'settings';
  await loadAdmin(tab, {
    createError: qs('create_error') || undefined,
    inviteError: qs('invite_error') || undefined,
    inviteInfo: qs('invite_info') || undefined,
    oauthError: qs('oauth_error') || undefined,
    oauthInfo: qs('oauth_info') || undefined,
    mailError: qs('mail_error') || undefined,
    mailInfo: qs('mail_info') || undefined
  });
}

boot().catch((err) => showAppError(err instanceof Error ? err.message : '管理后台加载失败'));

