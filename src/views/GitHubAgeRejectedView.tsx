import type { FC } from 'hono/jsx'

export const GitHubAgeRejectedView: FC<{
  minDays: number
  actualDays?: number | null
}> = ({ minDays, actualDays }) => {
  return (
    <div class="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
      <div class="w-full max-w-lg bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-amber-950/20">
        <div class="text-center mb-6">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 mb-4 border border-amber-500/20">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <h1 class="text-2xl font-bold tracking-tight text-white">GitHub 账号天数未达标</h1>
          <p class="mt-3 text-sm text-slate-400 leading-relaxed">
            当前站点要求 GitHub 账号注册满 <span class="text-amber-300 font-semibold">{minDays}</span> 天后才能注册。
            你的账号尚未满足该条件，因此本次注册已被拒绝，本地账号不会被创建。
          </p>
        </div>

        <div class="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-2 text-sm text-slate-300 mb-6">
          <div class="flex items-center justify-between gap-3">
            <span class="text-slate-500">最低要求</span>
            <span class="font-mono-custom text-amber-300">{minDays} 天</span>
          </div>
          {typeof actualDays === 'number' && Number.isFinite(actualDays) ? (
            <div class="flex items-center justify-between gap-3">
              <span class="text-slate-500">当前账号年龄（约）</span>
              <span class="font-mono-custom text-slate-200">{Math.max(0, Math.floor(actualDays))} 天</span>
            </div>
          ) : null}
        </div>

        <div class="space-y-3">
          <a
            href="/register"
            class="block w-full text-center py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition duration-200"
          >
            返回注册页
          </a>
          <a
            href="/login"
            class="block w-full text-center py-3 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl border border-slate-700 transition duration-200"
          >
            去登录
          </a>
        </div>

        <p class="mt-6 text-xs text-slate-500 text-center leading-relaxed">
          若你刚注册 GitHub，请等待满足天数后再试。若这是误拦，请联系站点管理员。
        </p>
      </div>
    </div>
  )
}
