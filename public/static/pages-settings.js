import {
  apiGet,
  apiMessage,
  apiPost,
  bindLogoutButtons,
  escapeAttr,
  escapeHtml,
  formatDate,
  mount,
  qs,
  showAppError
} from './app-core.js';
import { startRegistration } from './vendor/simplewebauthn-browser.js';

function alertBox(type, message) {
  if (!message) return '';
  const cls = type === 'error'
    ? 'bg-rose-500/10 border-rose-500/20 text-rose-400'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
  return `<div class="mb-4 p-3 rounded-md border text-sm ${cls}">${escapeHtml(message)}</div>`;
}

function roleBadge(role, superAdmin) {
  if (superAdmin) return '<span class="px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">超级管理员</span>';
  if (role === 'admin') return '<span class="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">管理员</span>';
  return '<span class="px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">普通用户</span>';
}

function renderSettings(data) {
  const user = data.user;
  const linked = data.linkedAccounts || [];
  const providers = data.availableProviders || [];
  const passkeys = data.passkeys || [];
  const linkedIds = new Set(linked.map((a) => a.providerId));
  const bindable = providers.filter((p) => !linkedIds.has(p.provider_id));
  const providerName = (id) => providers.find((p) => p.provider_id === id)?.name || id;
  const providerIcon = (id) => providers.find((p) => p.provider_id === id)?.icon_url || null;

  return `
  <div class="min-h-screen bg-slate-950 pb-16 text-slate-100">
    <header class="border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold font-mono-custom text-base">S</div>
          <span class="font-bold text-white tracking-wide">个人设置</span>
        </div>
        <div class="flex items-center gap-4 sm:gap-6 text-sm whitespace-nowrap">
          <a href="/" class="inline-flex items-center text-slate-300 hover:text-white transition font-medium">返回主页</a>
          ${user.role === 'admin' ? '<a href="/admin" class="inline-flex items-center text-slate-300 hover:text-white transition font-medium">管理后台</a>' : ''}
          <button type="button" data-action="logout" class="inline-flex items-center text-rose-400 hover:text-rose-300 transition font-medium leading-none">退出登录</button>
        </div>
      </div>
    </header>
    <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 mt-10">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8 items-start">
        <div class="md:col-span-1 space-y-6">
          <div class="bg-slate-900/40 border border-slate-800 rounded-lg p-6">
            <div class="flex flex-col items-center text-center">
              <div class="w-20 h-20 rounded-full bg-emerald-950 border border-emerald-800 flex items-center justify-center text-emerald-400 text-2xl font-bold mb-4">${escapeHtml((user.name || 'U').slice(0,1).toUpperCase())}</div>
              <h2 class="text-xl font-bold text-white mb-1">${escapeHtml(user.name || '未命名用户')}</h2>
              <div class="text-sm text-slate-400 font-mono-custom mb-3">${escapeHtml(user.email)}</div>
              ${roleBadge(user.role, !!user.super_admin)}
            </div>
            <div class="mt-8 pt-6 border-t border-slate-800 space-y-3">
              <div class="flex justify-between items-center text-sm"><span class="text-slate-400">已绑定社交账号</span><span class="text-white font-mono-custom">${linked.length}</span></div>
              <div class="flex justify-between items-center text-sm"><span class="text-slate-400">Passkey 密钥数量</span><span class="text-white font-mono-custom">${passkeys.length}</span></div>
            </div>
          </div>
        </div>
        <div class="md:col-span-2 space-y-6">
          <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
            <h3 class="text-base font-bold text-white mb-6 pb-3 border-b border-slate-800">基本资料修改</h3>
            <div id="profile-alert">${alertBox('error', data.profileError)}${alertBox('info', data.profileInfo)}</div>
            <form id="profile-form" class="space-y-4 max-w-xl">
              <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">用户名</label>
                <input type="text" name="name" required minlength="1" maxlength="64" value="${escapeAttr(user.name || '')}" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-md text-white focus:outline-none focus:border-emerald-500" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">邮箱</label>
                <input type="email" value="${escapeAttr(user.email || '')}" disabled class="w-full px-4 py-2.5 bg-slate-950/50 border border-slate-800 rounded-md text-slate-500 cursor-not-allowed" />
                <p class="mt-1 text-xs text-slate-500">邮箱用于登录标识，当前不支持在此修改。</p>
              </div>
              <button type="submit" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition">保存基本资料</button>
            </form>
          </section>

          <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
            <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
              <h3 class="text-base font-bold text-white">社交账号绑定</h3>
            </div>
            <div id="oauth-alert">${alertBox('error', data.oauthError)}${alertBox('info', data.oauthInfo)}</div>
            <div class="space-y-4 mb-8">
              <h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">已绑定</h4>
              ${linked.length === 0 ? '<div class="text-sm text-slate-500 py-4 px-3 rounded-md border border-dashed border-slate-800 bg-slate-950/30">暂未绑定任何社交账号</div>' : linked.map((account) => {
                const icon = providerIcon(account.providerId);
                return `<div class="flex items-center justify-between gap-3 p-3 rounded-md bg-slate-950 border border-slate-800">
                  <div class="flex items-center gap-3 min-w-0">
                    ${icon ? `<img src="${escapeAttr(icon)}" alt="" class="w-8 h-8 rounded-full bg-transparent object-cover" />` : `<div class="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-xs font-bold">${escapeHtml(providerName(account.providerId).slice(0,1).toUpperCase())}</div>`}
                    <div class="min-w-0">
                      <div class="text-sm text-white font-medium truncate">${escapeHtml(providerName(account.providerId))}</div>
                      <div class="text-xs text-slate-500 font-mono-custom truncate">${escapeHtml(account.accountId)}</div>
                    </div>
                  </div>
                  <button type="button" data-unlink-provider="${escapeAttr(account.providerId)}" data-unlink-account="${escapeAttr(account.accountId)}" class="shrink-0 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-md transition">解绑</button>
                </div>`;
              }).join('')}
            </div>
            <div class="space-y-4">
              <h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">可绑定</h4>
              ${providers.length === 0 ? '<div class="text-sm text-slate-500 py-4 px-3 rounded-md border border-dashed border-slate-800 bg-slate-950/30">管理员尚未配置可用的 OAuth 应用</div>'
                : bindable.length === 0 ? '<div class="text-sm text-slate-500 py-4 px-3 rounded-md border border-dashed border-slate-800 bg-slate-950/30">所有可用社交账号均已绑定</div>'
                : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${bindable.map((provider) => `
                  <div class="flex items-center justify-between gap-3 p-3 rounded-md bg-slate-950 border border-slate-800 hover:border-emerald-500/50 transition">
                    <div class="flex items-center gap-3 min-w-0">
                      ${provider.icon_url ? `<img src="${escapeAttr(provider.icon_url)}" alt="" class="w-8 h-8 rounded-full bg-transparent object-cover" />` : `<div class="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-xs font-bold">${escapeHtml(provider.name.slice(0,1).toUpperCase())}</div>`}
                      <div class="min-w-0">
                        <div class="text-sm text-white font-medium truncate">${escapeHtml(provider.name)}</div>
                        <div class="text-xs text-slate-500 font-mono-custom truncate">${escapeHtml(provider.provider_id)}</div>
                      </div>
                    </div>
                    <button type="button" data-link-provider="${escapeAttr(provider.provider_id)}" class="shrink-0 px-3 py-1.5 text-xs bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border border-emerald-500/20 rounded-md transition">绑定</button>
                  </div>`).join('')}</div>`}
            </div>
          </section>

          <section class="bg-slate-900/40 border border-slate-800 rounded-lg p-6 sm:p-8">
            <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800 gap-3">
              <div>
                <h3 class="text-base font-bold text-white">Passkey 辅助凭证</h3>
                <p class="text-xs text-slate-500 mt-1">使用本机的指纹、面容或安全密钥进行快捷登录</p>
              </div>
              <button type="button" id="add-passkey-btn" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-md transition">添加 Passkey</button>
            </div>
            <div id="passkey-alert">${alertBox('error', data.passkeyError)}${alertBox('info', data.passkeyInfo)}</div>
            <div id="passkey-client-error" class="hidden mb-4 p-3 rounded-md bg-rose-500/10 border border-rose-500/20 text-sm text-rose-400"></div>
            <div class="space-y-3">
              ${passkeys.length === 0 ? '<div class="text-sm text-slate-500 py-8 text-center rounded-md border border-dashed border-slate-800 bg-slate-950/30">尚未添加任何 Passkey</div>'
                : passkeys.map((item) => `
                  <div class="flex items-center justify-between gap-3 p-3 rounded-md bg-slate-950 border border-slate-800">
                    <div class="min-w-0">
                      <div class="text-sm text-white font-medium truncate">${escapeHtml(item.name || '未命名 Passkey')}</div>
                      <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(item.deviceType || 'unknown')}${item.backedUp ? ' · 已备份' : ''}${item.createdAt ? ` · ${escapeHtml(formatDate(item.createdAt))}` : ''}</div>
                    </div>
                    <button type="button" data-delete-passkey="${escapeAttr(item.id)}" class="px-3 py-1.5 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-md transition">删除</button>
                  </div>`).join('')}
            </div>
          </section>
        </div>
      </div>
    </main>
  </div>`;
}

async function reloadSettings(extra = {}) {
  const { res, data } = await apiGet('/api/pages/settings');
  if (data?.redirect) { window.location.href = data.redirect; return; }
  if (!res.ok || !data?.success) { showAppError(apiMessage(data, "设置页加载失败")); return; }
  mount(renderSettings({ ...data.data, ...extra }));
  bindEvents();
}

function bindEvents() {
  bindLogoutButtons();
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const { data } = await apiPost('/api/settings/profile', { name: String(fd.get('name') || '') });
    if (data?.success) {
      await reloadSettings({ profileInfo: data.message || "基本资料已保存" });
    } else {
      await reloadSettings({ profileError: apiMessage(data, "保存失败") });
    }
  });

  document.querySelectorAll('[data-link-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const providerId = btn.getAttribute('data-link-provider');
      const { data } = await apiPost('/api/settings/oauth/link', { provider_id: providerId });
      if (data?.redirect) { window.location.href = data.redirect; return; }
      await reloadSettings({ oauthError: apiMessage(data, "绑定失败") });
    });
  });

  document.querySelectorAll('[data-unlink-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { data } = await apiPost('/api/settings/oauth/unlink', {
        provider_id: btn.getAttribute('data-unlink-provider'),
        account_id: btn.getAttribute('data-unlink-account')
      });
      await reloadSettings(data?.success ? { oauthInfo: data.message || "已解绑" } : { oauthError: apiMessage(data, "解绑失败") });
    });
  });

  document.querySelectorAll('[data-delete-passkey]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm("确认删除该 Passkey？")) return;
      const { data } = await apiPost('/api/settings/passkey/delete', { id: btn.getAttribute('data-delete-passkey') });
      await reloadSettings(data?.success ? { passkeyInfo: data.message || "Passkey 已删除" } : { passkeyError: apiMessage(data, "删除失败") });
    });
  });

  document.getElementById('add-passkey-btn')?.addEventListener('click', async () => {
    const errorBox = document.getElementById('passkey-client-error');
    if (errorBox) { errorBox.classList.add('hidden'); errorBox.textContent = ''; }
    if (!window.PublicKeyCredential) {
      if (errorBox) { errorBox.textContent = "当前浏览器不支持 Passkey / WebAuthn"; errorBox.classList.remove('hidden'); }
      return;
    }
    const defaultName = `Passkey ${new Date().toLocaleString('zh-CN')}`;
    const name = window.prompt("请输入 Passkey 名称（可留空）", defaultName) ?? '';
    const addBtn = document.getElementById('add-passkey-btn');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = "添加中..."; }
    try {
      const optionsRes = await fetch('/api/auth/passkey/generate-register-options?name=' + encodeURIComponent(name.trim()), {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }
      });
      const optionsData = await optionsRes.json().catch(() => null);
      if (!optionsRes.ok || !optionsData) throw new Error(apiMessage(optionsData, "无法生成 Passkey 注册参数"));
      const attestation = await startRegistration({ optionsJSON: optionsData });
      const verifyRes = await fetch('/api/auth/passkey/verify-registration', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ response: attestation, name: name.trim() || undefined })
      });
      const verifyData = await verifyRes.json().catch(() => null);
      if (!verifyRes.ok) throw new Error(apiMessage(verifyData, "Passkey 注册失败"));
      await reloadSettings({ passkeyInfo: "Passkey 添加成功" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Passkey 添加失败";
      if (errorBox) {
        errorBox.textContent = /cancel|abort|notallowed/i.test(msg) ? "已取消 Passkey 添加" : msg;
        errorBox.classList.remove('hidden');
      }
    } finally {
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = "添加 Passkey"; }
    }
  });
}

async function boot() {
  const { res, data } = await apiGet('/api/pages/settings');
  if (data?.redirect) { window.location.href = data.redirect; return; }
  if (!res.ok || !data?.success) { showAppError(apiMessage(data, "设置页加载失败")); return; }
  const payload = {
    ...data.data,
    profileError: qs('profile_error') || undefined,
    profileInfo: qs('profile_info') || undefined,
    oauthError: qs('oauth_error') || undefined,
    oauthInfo: qs('oauth_info') || undefined,
    passkeyError: qs('passkey_error') || undefined,
    passkeyInfo: qs('passkey_info') || undefined
  };
  mount(renderSettings(payload));
  bindEvents();
}

boot().catch((err) => showAppError(err instanceof Error ? err.message : "设置页加载失败"));
