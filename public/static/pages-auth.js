import {
  apiGet,
  apiMessage,
  apiPost,
  escapeAttr,
  escapeHtml,
  mount,
  qs,
  showAppError
} from './app-core.js';
import { startAuthentication } from './vendor/simplewebauthn-browser.js';

function alertBox(type, message) {
  if (!message) return '';
  const cls = type === 'error'
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
  return `<div class="mb-6 p-4 rounded-xl border text-sm flex items-center gap-2 ${cls}"><span>${escapeHtml(message)}</span></div>`;
}

function oauthButtons(action, providers, next = '', inviteRequired = false) {
  if (!providers?.length) return '';
  return `
    <div class="mt-6 space-y-3">
      <div class="relative flex items-center justify-center my-2">
        <div class="absolute inset-0 flex items-center"><div class="w-full border-t border-slate-800"></div></div>
        <span class="relative px-3 bg-slate-900 text-xs text-slate-500 uppercase tracking-wider">${action === 'register' ? "第三方注册" : "第三方登录"}</span>
      </div>
      ${inviteRequired ? '<p class="text-xs text-slate-500 text-center">' + "使用第三方注册时也需要填写邀请码" + '</p>' : ''}
      ${providers.map((p) => `
        <form data-oauth-form="${escapeAttr(action)}" data-provider="${escapeAttr(p.provider_id)}" class="space-y-2">
          ${inviteRequired ? '<input type="text" name="invite_code" required placeholder="' + "邀请码" + '" class="w-full px-4 py-2 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom tracking-widest focus:outline-none focus:border-emerald-500" />' : ''}
          <button type="submit" class="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white font-medium rounded-xl transition duration-200 border border-slate-700 shadow-md active:scale-[0.98] flex items-center justify-center gap-3">
            ${p.icon_url ? `<img src="${escapeAttr(p.icon_url)}" alt="" class="w-5 h-5 object-contain rounded-full" />` : ''}
            <span>${"使用"} ${escapeHtml(p.name)} ${action === 'register' ? "注册 / 登录" : "登录"}</span>
          </button>
        </form>
      `).join('')}
    </div>`;
}

function shellCard(title, subtitle, body) {
  return `
  <div class="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
    <div class="w-full max-w-md bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-emerald-950/20">
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 mb-4 border border-emerald-500/20">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" /></svg>
        </div>
        <h2 class="text-2xl font-bold tracking-tight text-white">${escapeHtml(title)}</h2>
        <p class="mt-2 text-sm text-slate-400">${escapeHtml(subtitle)}</p>
      </div>
      ${body}
    </div>
  </div>`;
}

function renderLogin(data) {
  const next = data.next || '/';
  const providers = data.oauthProviders || [];
  const body = `
    ${alertBox('info', data.info)}
    ${alertBox('error', data.error)}
    <div id="form-error" class="hidden"></div>
    <div id="passkey-login-error" class="hidden mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400"></div>
    <form id="login-form" class="space-y-5">
      <div>
        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"邮箱"}</label>
        <input type="email" name="email" required autocomplete="email" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition" placeholder="name@example.com" />
      </div>
      <div>
        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"密码"}</label>
        <input type="password" name="password" required autocomplete="current-password" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition" placeholder="********" />
      </div>
      <button type="submit" class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition duration-200 transform active:scale-[0.98] shadow-lg shadow-emerald-950/50">${"登录"}</button>
    </form>
    <div class="mt-4">
      <button type="button" id="passkey-login-btn" class="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white font-medium rounded-xl transition duration-200 border border-slate-700 shadow-md active:scale-[0.98]">${"使用 Passkey 登录"}</button>
    </div>
    ${oauthButtons('login', providers, next, false)}
    <div class="mt-8 pt-6 border-t border-slate-800/60 text-center">
      <p class="text-sm text-slate-400">${"还没有账号？ "}<a href="/register" class="font-medium text-emerald-400 hover:text-emerald-300 transition">${"立即注册"}</a></p>
    </div>`;
  return shellCard("登录账号", "Minecraft 端口隐藏服务平台", body);
}

function renderRegister(data) {
  const settings = data.settings || {};
  const providers = data.oauthProviders || [];
  const showEmail = settings.registration_mode === 'email' || settings.registration_mode === 'both';
  const showOAuth = (settings.registration_mode === 'oauth' || settings.registration_mode === 'both') && settings.registration_enabled;
  const needVerification = !!settings.email_verification_required && showEmail;
  const hasGitHub = providers.some((p) => p.provider_id === 'github');
  let body = `${alertBox('error', data.error)}${alertBox('info', data.info)}`;
  if (!settings.registration_enabled) {
    body += `<div class="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 text-center">${"管理员已关闭注册。"}</div>`;
  }
  if (settings.registration_enabled && showEmail) {
    body += `
      <form id="register-form" class="space-y-5">
        <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"用户名"}</label><input type="text" name="name" required autocomplete="name" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" placeholder="mc_player" /></div>
        <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"邮箱"}</label><input type="email" name="email" required autocomplete="email" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" placeholder="name@example.com" /></div>
        <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"密码（至少 8 位）"}</label><input type="password" name="password" required minlength="8" autocomplete="new-password" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" placeholder="********" /></div>
        ${settings.invite_required ? '<div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">' + "邀请码" + '</label><input type="text" name="invite_code" required class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom tracking-widest focus:outline-none focus:border-emerald-500" placeholder="XXXXX-XXXXX" /></div>' : ''}
        ${needVerification ? '<p class="text-xs text-slate-400 bg-slate-950/40 p-3 rounded-lg border border-slate-800/80">' + "填写后会发送验证码到你的邮箱，再进入下一步验证。" + '</p>' : ''}
        <button type="submit" class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition">${needVerification ? "发送验证码" : "注册"}</button>
      </form>`;
  }
  if (showOAuth && providers.length) {
    if (hasGitHub && settings.github_min_account_age_days > 0) {
      body += `<p class="mt-4 text-xs text-amber-400/90 text-center bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">${"GitHub 账号需满足最短注册 "}${settings.github_min_account_age_days}${ " 天" }</p>`;
    }
    body += oauthButtons('register', providers, '', !!settings.invite_required);
  }
  body += `<div class="mt-8 pt-6 border-t border-slate-800/60 text-center"><p class="text-sm text-slate-400">${"已有账号？ "}<a href="/login" class="font-medium text-emerald-400 hover:text-emerald-300 transition">${"去登录"}</a></p></div>`;
  return shellCard("创建账号", "Minecraft 端口隐藏服务平台", body);
}

function renderVerify(data) {
  const body = `
    ${alertBox('error', data.error)}
    <p class="text-sm text-slate-300 mb-6 text-center">${"请输入发送到 "}<strong class="text-emerald-400 font-mono-custom">${escapeHtml(data.email || '')}</strong>${" 的验证码。"}</p>
    <form id="verify-form" class="space-y-6">
      <input type="hidden" name="email" value="${escapeAttr(data.email || '')}" />
      <div>
        <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 text-center">${"验证码"}</label>
        <input type="text" name="code" required pattern="[0-9]{6}" maxlength="6" placeholder="000000" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom text-center text-3xl tracking-[0.5em] focus:outline-none focus:border-emerald-500" />
      </div>
      <button type="submit" class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition">${"确认注册"}</button>
    </form>`;
  return shellCard("邮箱验证", "已向您的邮箱发送了 6 位数验证码", body);
}

function renderSetup(data) {
  const body = `
    ${alertBox('error', data.error)}
    <form id="setup-form" class="space-y-5">
      <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"用户名"}</label><input type="text" name="name" required class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" placeholder="admin" /></div>
      <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"邮箱"}</label><input type="email" name="email" required class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" placeholder="admin@example.com" /></div>
      <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"密码（至少 8 位）"}</label><input type="password" name="password" required minlength="8" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" /></div>
      <div><label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">${"确认密码"}</label><input type="password" name="confirm" required minlength="8" class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500" /></div>
      <button type="submit" class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition">${"创建并登录管理员"}</button>
    </form>`;
  return shellCard("初始化管理员", "尚未创建任何账号。请先创建第一个管理员账户。", body);
}

function renderGithubAge(data) {
  const minDays = data.minDays || 0;
  const actual = data.actualDays;
  return `
  <div class="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
    <div class="w-full max-w-lg bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-amber-950/20">
      <div class="text-center mb-6">
        <h1 class="text-2xl font-bold tracking-tight text-white">${"GitHub 账号天数未达标"}</h1>
        <p class="mt-3 text-sm text-slate-400 leading-relaxed">${"当前站点要求 GitHub 账号注册满 "}<span class="text-amber-300 font-semibold">${escapeHtml(String(minDays))}</span>${" 天后才能注册。你的账号尚未满足该条件，因此本次注册已被拒绝，本地账号不会被创建。"}</p>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-2 text-sm text-slate-300 mb-6">
        <div class="flex items-center justify-between gap-3"><span class="text-slate-500">${"最低要求"}</span><span class="font-mono-custom text-amber-300">${escapeHtml(String(minDays))}${ " 天" }</span></div>
        ${typeof actual === 'number' ? `<div class="flex items-center justify-between gap-3"><span class="text-slate-500">${"当前账号年龄（约）"}</span><span class="font-mono-custom text-slate-200">${Math.max(0, Math.floor(actual))}${ " 天" }</span></div>` : ''}
      </div>
      <div class="space-y-3">
        <a href="/register" class="block w-full text-center py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition">${"返回注册页"}</a>
        <a href="/login" class="block w-full text-center py-3 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl border border-slate-700 transition">${"去登录"}</a>
      </div>
    </div>
  </div>`;
}

function setInlineError(message) {
  const el = document.getElementById('form-error') || document.getElementById('passkey-login-error');
  if (!el) { alert(message); return; }
  el.className = 'mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400';
  el.textContent = message;
  el.classList.remove('hidden');
}

async function handleOAuth(action, providerId, inviteCode = '', next = '/') {
  const url = action === 'register' ? '/api/auth/oauth/register' : `/api/auth/oauth/login?next=${encodeURIComponent(next)}`;
  const { data } = await apiPost(url, { provider_id: providerId, invite_code: inviteCode });
  if (data?.redirect) { window.location.href = data.redirect; return; }
  throw new Error(apiMessage(data, "OAuth 启动失败"));
}

async function bindAuthForms(page, payload) {
  if (page === 'login') {
    document.getElementById('login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const { data } = await apiPost(`/api/auth/login?next=${encodeURIComponent(payload.next || '/')}`, {
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || '')
      });
      if (data?.redirect) { window.location.href = data.redirect; return; }
      setInlineError(apiMessage(data, "登录失败"));
    });
    const passkeyBtn = document.getElementById('passkey-login-btn');
    passkeyBtn?.addEventListener('click', async () => {
      const errorBox = document.getElementById('passkey-login-error');
      if (errorBox) { errorBox.classList.add('hidden'); errorBox.textContent = ''; }
      if (!window.PublicKeyCredential) { setInlineError("当前浏览器不支持 Passkey / WebAuthn"); return; }
      passkeyBtn.disabled = true; passkeyBtn.textContent = "验证中...";
      try {
        const optionsRes = await fetch('/api/auth/passkey/generate-authenticate-options', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const optionsData = await optionsRes.json().catch(() => null);
        if (!optionsRes.ok || !optionsData) throw new Error(apiMessage(optionsData, "无法生成 Passkey 登录参数"));
        const assertion = await startAuthentication({ optionsJSON: optionsData });
        const { clientExtensionResults, ...responseBody } = assertion;
        const verifyRes = await fetch('/api/auth/passkey/verify-authentication', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ response: responseBody }) });
        const verifyData = await verifyRes.json().catch(() => null);
        if (!verifyRes.ok) throw new Error(apiMessage(verifyData, "Passkey 登录失败"));
        window.location.href = payload.next || '/';
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Passkey 登录失败";
        setInlineError(/cancel|abort|notallowed/i.test(msg) ? "已取消 Passkey 登录" : msg);
      } finally {
        passkeyBtn.disabled = false; passkeyBtn.textContent = "使用 Passkey 登录";
      }
    });
  }

  if (page === 'register') {
    document.getElementById('register-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const { data } = await apiPost('/api/auth/register', {
        name: String(fd.get('name') || ''),
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        invite_code: String(fd.get('invite_code') || '')
      });
      if (data?.redirect) { window.location.href = data.redirect; return; }
      if (data?.success && data?.data?.need_verification) {
        window.location.href = `/verify-email?email=${encodeURIComponent(data.data.email)}`;
        return;
      }
      const pageRes = await apiGet('/api/pages/register');
      if (pageRes.data?.success) {
        mount(renderRegister({ ...pageRes.data.data, error: apiMessage(data, "注册失败") }));
        await bindAuthForms('register', pageRes.data.data);
      } else {
        setInlineError(apiMessage(data, "注册失败"));
      }
    });
  }

  if (page === 'verify') {
    document.getElementById('verify-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const email = String(fd.get('email') || '');
      const { data } = await apiPost('/api/auth/verify-email', { email, code: String(fd.get('code') || '') });
      if (data?.redirect) { window.location.href = data.redirect; return; }
      mount(renderVerify({ email, error: apiMessage(data, "验证失败") }));
      await bindAuthForms('verify', { email });
    });
  }

  if (page === 'setup') {
    document.getElementById('setup-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const { data } = await apiPost('/api/auth/setup', {
        name: String(fd.get('name') || ''),
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        confirm: String(fd.get('confirm') || '')
      });
      if (data?.redirect) { window.location.href = data.redirect; return; }
      mount(renderSetup({ error: apiMessage(data, "创建管理员失败") }));
      await bindAuthForms('setup', {});
    });
  }

  document.querySelectorAll('form[data-oauth-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = form.getAttribute('data-oauth-form');
      const providerId = form.getAttribute('data-provider');
      const fd = new FormData(form);
      try {
        await handleOAuth(action, providerId, String(fd.get('invite_code') || ''), payload.next || '/');
      } catch (err) {
        setInlineError(err instanceof Error ? err.message : "OAuth 失败");
      }
    });
  });
}

async function boot() {
  const page = document.getElementById('app')?.dataset.page || '';
  if (page === 'login') {
    const next = qs('next', '/');
    const { res, data } = await apiGet(`/api/pages/login?next=${encodeURIComponent(next)}`);
    if (data?.redirect) { window.location.href = data.redirect; return; }
    if (!res.ok || !data?.success) { showAppError(apiMessage(data, "登录页加载失败")); return; }
    const payload = { ...data.data, error: qs('error') || data.data.error, info: qs('registered') ? "注册成功，请登录" : data.data.info };
    mount(renderLogin(payload));
    await bindAuthForms('login', payload);
    return;
  }
  if (page === 'register') {
    const { res, data } = await apiGet('/api/pages/register');
    if (data?.redirect) { window.location.href = data.redirect; return; }
    if (!res.ok || !data?.success) { showAppError(apiMessage(data, "注册页加载失败")); return; }
    const payload = { ...data.data, error: qs('error') || data.data.error };
    mount(renderRegister(payload));
    await bindAuthForms('register', payload);
    return;
  }
  if (page === 'verify-email') {
    const email = qs('email', '');
    mount(renderVerify({ email, error: qs('error') }));
    await bindAuthForms('verify', { email });
    return;
  }
  if (page === 'setup') {
    const { res, data } = await apiGet('/api/pages/setup');
    if (data?.redirect) { window.location.href = data.redirect; return; }
    if (!res.ok || !data?.success) { showAppError(apiMessage(data, "初始化页加载失败")); return; }
    mount(renderSetup(data.data || {}));
    await bindAuthForms('setup', {});
    return;
  }
  if (page === 'github-age-rejected') {
    const { res, data } = await apiGet(`/api/pages/github-age-rejected?min_days=${encodeURIComponent(qs('min_days', '0'))}&actual_days=${encodeURIComponent(qs('actual_days', ''))}`);
    if (!res.ok || !data?.success) { showAppError(apiMessage(data, "页面加载失败")); return; }
    mount(renderGithubAge(data.data));
    return;
  }
  showAppError("未知页面");
}

boot().catch((err) => showAppError(err instanceof Error ? err.message : "页面加载失败"));
