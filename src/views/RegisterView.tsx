import type { FC } from 'hono/jsx'
import type { Settings } from '../services/settings'
import type { OAuthProviderPublic } from '../services/oauth-providers'

export const RegisterView: FC<{
  settings: Settings
  error?: string
  info?: string
  askCode?: boolean
  email?: string
  oauthProviders?: OAuthProviderPublic[]
}> = ({ settings, error, info, askCode, email, oauthProviders = [] }) => {
  const showEmail = settings.registration_mode === 'email' || settings.registration_mode === 'both'
  const showOAuth =
    (settings.registration_mode === 'oauth' || settings.registration_mode === 'both') &&
    settings.registration_enabled
  const needVerification = settings.resend_enabled && showEmail
  const hasGitHubProvider = oauthProviders.some((p) => p.provider_id === 'github')

  return (
    <div class="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
      <div class="w-full max-w-md bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-emerald-950/20">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 mb-4 border border-emerald-500/20">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
          </div>
          <h2 class="text-2xl font-bold tracking-tight text-white">创建账号</h2>
          <p class="mt-2 text-sm text-slate-400">Minecraft 端口隐藏服务平台</p>
        </div>

        {error && (
          <div class="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {info && (
          <div class="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
            </svg>
            <span>{info}</span>
          </div>
        )}

        {!settings.registration_enabled && (
          <div class="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 text-center">
            管理员已关闭注册。
          </div>
        )}

        {settings.registration_enabled && showEmail && !askCode && (
          <form method="post" action="/register" class="space-y-5">
            <div>
              <label for="name" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">用户名</label>
              <input
                type="text"
                id="name"
                name="name"
                required
                autocomplete="name"
                class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                placeholder="mc_player"
              />
            </div>

            <div>
              <label for="email" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">邮箱</label>
              <input
                type="email"
                id="email"
                name="email"
                required
                autocomplete="email"
                class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                placeholder="name@example.com"
              />
            </div>

            <div>
              <label for="password" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">密码（至少 8 位）</label>
              <input
                type="password"
                id="password"
                name="password"
                required
                minLength={8}
                autocomplete="new-password"
                class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                placeholder="********"
              />
            </div>

            {settings.invite_required && (
              <div>
                <label for="invite_code" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">邀请码</label>
                <input
                  type="text"
                  id="invite_code"
                  name="invite_code"
                  required
                  class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom tracking-widest focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                  placeholder="XXXXX-XXXXX"
                />
              </div>
            )}

            {needVerification && (
              <p class="text-xs text-slate-400 bg-slate-950/40 p-3 rounded-lg border border-slate-800/80">
                填写后会发送验证码到你的邮箱，再进入下一步验证。
              </p>
            )}

            <button
              type="submit"
              class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition duration-200 transform active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 shadow-lg shadow-emerald-950/50"
            >
              {needVerification ? '发送验证码' : '注册'}
            </button>
          </form>
        )}

        {settings.registration_enabled && showEmail && askCode && (
          <form method="post" action="/verify-email" class="space-y-5">
            <input type="hidden" name="email" value={email ?? ''} />
            <p class="text-sm text-slate-300">
              请输入发送到 <strong class="text-emerald-400 font-mono-custom">{email ?? ''}</strong> 的验证码：
            </p>
            <div>
              <label for="code" class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">验证码</label>
              <input
                type="text"
                id="code"
                name="code"
                required
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="123456"
                class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom text-center text-2xl tracking-widest focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
              />
            </div>
            <input type="hidden" name="name" value="" id="hidden_name" />
            <button
              type="submit"
              class="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition duration-200 transform active:scale-[0.98] focus:outline-none"
            >
              确认注册
            </button>
          </form>
        )}

        {showOAuth && oauthProviders.length > 0 && (
          <div class="mt-6 space-y-3">
            <div class="relative flex items-center justify-center my-2">
              <div class="absolute inset-0 flex items-center">
                <div class="w-full border-t border-slate-800"></div>
              </div>
              <span class="relative px-3 bg-slate-900 text-xs text-slate-500 uppercase tracking-wider">第三方注册</span>
            </div>
            {settings.invite_required && (
              <p class="text-xs text-slate-500 text-center">使用第三方注册时也需要填写邀请码</p>
            )}
            {hasGitHubProvider && settings.github_min_account_age_days > 0 && (
              <p class="text-xs text-amber-400/90 text-center bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                GitHub 账号需满足最短注册 {settings.github_min_account_age_days} 天
              </p>
            )}
            {oauthProviders.map((p) => (
              <form method="post" action="/register/oauth" class="space-y-2">
                <input type="hidden" name="provider_id" value={p.provider_id} />
                {settings.invite_required && (
                  <input
                    type="text"
                    name="invite_code"
                    required
                    placeholder="邀请码"
                    class="w-full px-4 py-2 bg-slate-950/60 border border-slate-800 rounded-xl text-white font-mono-custom tracking-widest focus:outline-none focus:border-emerald-500"
                  />
                )}
                <button
                  type="submit"
                  class="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white font-medium rounded-xl transition duration-200 border border-slate-700 shadow-md active:scale-[0.98] flex items-center justify-center gap-3"
                >
                  {p.icon_url ? (
                    <img src={p.icon_url} alt="" class="w-5 h-5 object-contain bg-white/90 rounded-sm p-0.5" />
                  ) : null}
                  <span>使用 {p.name} 注册 / 登录</span>
                </button>
              </form>
            ))}
          </div>
        )}

        <div class="mt-8 pt-6 border-t border-slate-800/60 text-center">
          <p class="text-sm text-slate-400">
            已有账号？{" "}
            <a href="/login" class="font-medium text-emerald-400 hover:text-emerald-300 transition">
              去登录
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
