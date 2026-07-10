import type { FC } from 'hono/jsx'
import type { DnsRecordRow, UserListRow } from '../services/dns-records'
import type { Settings } from '../services/settings'

export const AdminView: FC<{
  users: UserListRow[]
  records: DnsRecordRow[]
  settings: Settings
  currentUserId: string
  currentUserSuperAdmin: boolean
  createError?: string
}> = ({ users, records, settings, currentUserId, currentUserSuperAdmin, createError }) => {
  return (
    <div class="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black pb-16">
      {/* Navigation Header */}
      <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-10">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold font-mono-custom text-lg">
              A
            </div>
            <span class="font-bold text-white tracking-wide">管理员后台</span>
          </div>
          
          <div class="flex items-center gap-6 text-sm">
            <a href="/" class="text-slate-300 hover:text-white transition flex items-center gap-1.5 font-medium">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              返回主页
            </a>
            <a href="/logout" class="text-rose-400 hover:text-rose-300 transition font-medium">退出登录</a>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 mt-10 space-y-10">
        
        {/* Registration & Settings Section */}
        <section class="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8 shadow-xl">
          <h3 class="text-xl font-bold text-white mb-6 pb-3 border-b border-slate-800 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            </svg>
            全局与注册配置
          </h3>

          <form method="post" action="/admin/settings" class="space-y-6">
            
            {/* Top Grid */}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Left Column: Register settings */}
              <div class="space-y-5">
                <div class="flex items-center gap-3 bg-slate-950/40 p-4 rounded-xl border border-slate-800/80">
                  <input 
                    type="checkbox" 
                    id="registration_enabled"
                    name="registration_enabled" 
                    checked={settings.registration_enabled} 
                    class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-800"
                  />
                  <label for="registration_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">开启开放注册</label>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">注册通道模式</label>
                  <select 
                    name="registration_mode"
                    class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition cursor-pointer"
                  >
                    <option value="email" selected={settings.registration_mode === 'email'}>仅邮箱模式</option>
                    <option value="github" selected={settings.registration_mode === 'github'}>仅 GitHub 授权模式</option>
                    <option value="both" selected={settings.registration_mode === 'both'}>邮箱 + GitHub 双模式</option>
                  </select>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">GitHub 账号最短注册天数限制</label>
                  <input
                    type="number"
                    name="github_min_account_age_days"
                    value={settings.github_min_account_age_days}
                    min="0"
                    class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition font-mono-custom"
                    placeholder="0"
                  />
                  <span class="text-xs text-slate-500 mt-1 block">设置为 0 表示不限制</span>
                </div>

                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">每用户记录数量上限</label>
                  <input
                    type="number"
                    name="max_records_per_user"
                    value={settings.max_records_per_user}
                    min="0"
                    class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition font-mono-custom"
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
                    class="w-full px-4 py-3 bg-slate-950/60 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition font-mono-custom"
                    placeholder="0"
                  />
                  <span class="text-xs text-slate-500 mt-1 block">例如设置为 4 时，仅允许 1111.example.com 或更长子域名；设为 0 表示不限制。</span>
                </div>
              </div>

              {/* Right Column: Whitelist/Blacklist */}
              <div class="space-y-5">
                <div class="space-y-3 bg-slate-950/40 p-4 rounded-xl border border-slate-800/80">
                  <div class="flex items-center gap-3">
                    <input 
                      type="checkbox" 
                      id="email_whitelist_enabled"
                      name="email_whitelist_enabled" 
                      checked={settings.email_whitelist_enabled} 
                      class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-800"
                    />
                    <label for="email_whitelist_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱后缀白名单</label>
                  </div>
                  <div>
                    <input 
                      type="text" 
                      name="email_whitelist_suffixes" 
                      value={settings.email_whitelist_suffixes.join(',')} 
                      class="w-full mt-1 px-3 py-2 bg-slate-950/60 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
                      placeholder="逗号分隔，如 gmail.com, 163.com"
                    />
                  </div>
                </div>

                <div class="space-y-3 bg-slate-950/40 p-4 rounded-xl border border-slate-800/80">
                  <div class="flex items-center gap-3">
                    <input 
                      type="checkbox" 
                      id="email_blacklist_enabled"
                      name="email_blacklist_enabled" 
                      checked={settings.email_blacklist_enabled} 
                      class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-800"
                    />
                    <label for="email_blacklist_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱后缀黑名单</label>
                  </div>
                  <div>
                    <input 
                      type="text" 
                      name="email_blacklist_suffixes" 
                      value={settings.email_blacklist_suffixes.join(',')} 
                      class="w-full mt-1 px-3 py-2 bg-slate-950/60 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition"
                      placeholder="逗号分隔，如 tempmail.com"
                    />
                  </div>
                </div>
              </div>

            </div>

            {/* Resend Service Panel */}
            <div class="p-6 bg-slate-950/50 rounded-xl border border-slate-800/80 space-y-4">
              <h4 class="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                邮件服务 (Resend HTTP API)
              </h4>
              
              <div class="flex items-center gap-3">
                <input 
                  type="checkbox" 
                  id="resend_enabled"
                  name="resend_enabled" 
                  checked={settings.resend_enabled} 
                  class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 bg-slate-950 border-slate-800"
                />
                <label for="resend_enabled" class="text-sm font-medium text-slate-200 cursor-pointer">启用邮箱接收验证码注册流程</label>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Resend API Key</label>
                  <input 
                    type="password" 
                    name="resend_api_key" 
                    placeholder={settings.resend_api_key ? '已配置（留空则不更新）' : 're_xxxxxxxx'} 
                    class="w-full px-4 py-2.5 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
                  />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">发件人地址</label>
                  <input 
                    type="email" 
                    name="resend_from" 
                    value={settings.resend_from ?? ''} 
                    placeholder="noreply@yourdomain.com"
                    class="w-full px-4 py-2.5 bg-slate-950/60 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
                  />
                </div>
              </div>
              <p class="text-xs text-slate-500">提示：如未启用或未配置邮件服务，邮箱注册将免验证直接完成。</p>
            </div>

            <div class="flex justify-end">
              <button 
                type="submit" 
                class="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition duration-200 active:scale-[0.98] focus:outline-none shadow-lg shadow-emerald-950/50"
              >
                保存全局设置
              </button>
            </div>
          </form>
        </section>

        {/* User Management Section */}
        <section class="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8 shadow-xl">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-xl font-bold text-white flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              用户管理 ({users.length})
            </h3>
            <span class="text-xs text-slate-500">管理平台账号、修改权限角色或注销账号</span>
          </div>

          {createError && (
            <div class="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-sm text-rose-400">
              {createError}
            </div>
          )}

          {/* 手动创建用户 */}
          <div class="mb-6 p-5 bg-slate-950/40 rounded-xl border border-slate-800/80">
            <h4 class="text-sm font-bold text-white mb-4 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              手动创建用户
            </h4>
            <form method="post" action="/admin/users/create" class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div class="md:col-span-3">
                <label class="block text-xs font-semibold text-slate-500 mb-1">用户名</label>
                <input type="text" name="name" required class="w-full px-3 py-2 bg-slate-900/60 border border-slate-800 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="newuser" />
              </div>
              <div class="md:col-span-4">
                <label class="block text-xs font-semibold text-slate-500 mb-1">邮箱</label>
                <input type="email" name="email" required class="w-full px-3 py-2 bg-slate-900/60 border border-slate-800 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="user@example.com" />
              </div>
              <div class="md:col-span-3">
                <label class="block text-xs font-semibold text-slate-500 mb-1">密码 (≥8)</label>
                <input type="password" name="password" required minLength={8} class="w-full px-3 py-2 bg-slate-900/60 border border-slate-800 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500" placeholder="••••••••" />
              </div>
              <div class="md:col-span-1">
                <label class="block text-xs font-semibold text-slate-500 mb-1">角色</label>
                <select name="role" disabled={!currentUserSuperAdmin} class="w-full px-2 py-2 bg-slate-900/60 border border-slate-800 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed">
                  <option value="user" selected>用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div class="md:col-span-1">
                <button type="submit" class="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition active:scale-[0.98]">创建</button>
              </div>
            </form>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-sm text-left border-collapse">
              <thead>
                <tr class="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <th class="py-4 px-4">用户名</th>
                  <th class="py-4 px-4">注册邮箱</th>
                  <th class="py-4 px-4">角色</th>
                  <th class="py-4 px-4">记录上限</th>
                  <th class="py-4 px-4">验证状态</th>
                  <th class="py-4 px-4">注册时间</th>
                  <th class="py-4 px-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                {users.map((u) => {
                  const isSuper = !!u.super_admin
                  const hasUnlimitedRecords = isSuper || u.role === 'admin'
                  return (
                  <tr class="hover:bg-slate-900/40 transition">
                    <td class="py-4 px-4 text-white font-medium">
                      {u.name}
                      {u.id === currentUserId && (
                        <span class="ml-2 text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-normal">你</span>
                      )}
                    </td>
                    <td class="py-4 px-4 font-mono-custom text-slate-300">{u.email}</td>
                    <td class="py-4 px-4">
                      {isSuper ? (
                        <span class="px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">超级管理员</span>
                      ) : u.role === 'admin' ? (
                        <span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">管理员</span>
                      ) : (
                        <span class="px-2 py-0.5 rounded text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">普通用户</span>
                      )}
                    </td>
                    <td class="py-4 px-4 font-mono-custom text-slate-300 text-xs">
                      {hasUnlimitedRecords ? (
                        <span class="text-amber-400">∞</span>
                      ) : (
                        <form method="post" action={`/admin/users/${u.id}/limit`} class="flex items-center gap-1">
                          <input
                            type="number"
                            name="record_limit"
                            min="0"
                            value={u.record_limit === null || u.record_limit === undefined ? '' : u.record_limit}
                            placeholder={String(settings.max_records_per_user)}
                            class="w-16 px-2 py-1 bg-slate-900/60 border border-slate-800 rounded text-white text-xs focus:outline-none focus:border-emerald-500 font-mono-custom"
                          />
                          <button type="submit" class="px-1.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded transition" title="留空跟随全局上限">保存</button>
                        </form>
                      )}
                    </td>
                    <td class="py-4 px-4">
                      {u.emailVerified ? (
                        <span class="text-emerald-400 flex items-center gap-1"><span class="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>已验证</span>
                      ) : (
                        <span class="text-slate-500 flex items-center gap-1"><span class="w-1.5 h-1.5 bg-slate-600 rounded-full"></span>未验证</span>
                      )}
                    </td>
                    <td class="py-4 px-4 text-slate-400 text-xs">{new Date(u.createdAt).toLocaleString('zh-CN')}</td>
                    <td class="py-4 px-4 text-right">
                      {u.id !== currentUserId && !isSuper && (currentUserSuperAdmin || u.role !== 'admin') && (
                        <div class="flex justify-end gap-2">
                          {currentUserSuperAdmin && (u.role !== 'admin' ? (
                            <form method="post" action={`/admin/users/${u.id}/role`} class="inline">
                              <input type="hidden" name="role" value="admin" />
                              <button type="submit" class="px-2.5 py-1 text-xs bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-900/30 rounded-lg transition active:scale-[0.98]">
                                设为管理员
                              </button>
                            </form>
                          ) : (
                            <form method="post" action={`/admin/users/${u.id}/role`} class="inline">
                              <input type="hidden" name="role" value="user" />
                              <button type="submit" class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition active:scale-[0.98]">
                                降为普通用户
                              </button>
                            </form>
                          ))}
                          <form method="post" action={`/admin/users/${u.id}/delete`} class="inline" onsubmit="return confirm('确认删除该用户？将级联删除其所有 DNS 记录和关联会话！');">
                            <button type="submit" class="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-lg transition active:scale-[0.98]">
                              删除用户
                            </button>
                          </form>
                        </div>
                      )}
                      {isSuper && (
                        <span class="text-xs text-amber-500/70 italic">受保护</span>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* DNS Records Section */}
        <section class="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8 shadow-xl">
          <div class="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
            <h3 class="text-xl font-bold text-white flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              全局 DNS 记录管理 ({records.length})
            </h3>
            <span class="text-xs text-slate-500">列出所有用户的 DNS 解析状态，支持强制干预删除</span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-sm text-left border-collapse">
              <thead>
                <tr class="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <th class="py-4 px-4">主机名</th>
                  <th class="py-4 px-4">目标服务器</th>
                  <th class="py-4 px-4">端口</th>
                  <th class="py-4 px-4">类型</th>
                  <th class="py-4 px-4">所有者 ID</th>
                  <th class="py-4 px-4">创建时间</th>
                  <th class="py-4 px-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                {records.map((r) => (
                  <tr class="hover:bg-slate-900/40 transition">
                    <td class="py-4 px-4 font-mono-custom text-emerald-400 break-all select-all cursor-pointer">{r.host_name}</td>
                    <td class="py-4 px-4 font-mono-custom text-slate-300 break-all">{r.server_address}</td>
                    <td class="py-4 px-4 font-mono-custom text-slate-300">{r.port}</td>
                    <td class="py-4 px-4"><span class="px-2 py-0.5 rounded text-xs font-mono-custom bg-slate-800 text-slate-300">{r.target_type}</span></td>
                    <td class="py-4 px-4 font-mono-custom text-slate-400 text-xs" title={r.user_id ?? ''}>{r.user_id ? r.user_id.slice(0, 8) : '系统'}</td>
                    <td class="py-4 px-4 text-slate-400 text-xs">{new Date(r.created_at).toLocaleString('zh-CN')}</td>
                    <td class="py-4 px-4 text-right">
                      <form method="post" action={`/admin/dns/${r.id}/delete`} class="inline" onsubmit="return confirm('确认删除？此操作将永久抹除 Cloudflare 中的解析数据！');">
                        <button type="submit" class="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-900/30 rounded-lg transition active:scale-[0.98]">
                          强制删除
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {records.length === 0 && (
                  <tr>
                    <td colSpan={7} class="py-12 text-center text-slate-500">
                      <div class="flex flex-col items-center justify-center gap-3">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                        </svg>
                        <span>目前系统里没有任何 DNS 解析记录</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

      </main>
    </div>
  )
}
