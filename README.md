# Minecraft 端口隐藏工具

基于 Cloudflare Workers + Hono + better-auth 实现的 Minecraft 端口隐藏工具。通过 Cloudflare DNS SRV 记录，让玩家无需输入端口号即可连接服务器。

## 主要特性

- **首次启动自动 onboarding**：检测到无用户时强制跳转 `/setup` 创建首个管理员并直接登录；首个用户自动标记为超级管理员（不可被其他管理员降级或删除）
- **多角色权限**：普通用户可创建/删除自己的 DNS 记录；管理员可访问后台管理用户、记录与全局设置；管理员可在后台手动创建用户
- **可配置注册流程**：后台可开关注册，模式为 `email` / `oauth` / `both`
- **邀请码注册（可选）**：开启后邮箱与 OAuth 注册都需要邀请码；仅管理员/超级管理员可生成
- **邮箱后缀白/黑名单**：可同时启用，按后缀匹配（支持子域，如 `gmail.com` 会匹配 `mail.gmail.com`）
- **邮箱验证码**：启用 Resend 后需邮箱验证码注册；验证码哈希存储，待注册密码使用 `BETTER_AUTH_SECRET` 密封保存
- **通用 OAuth 登录/注册**：后台添加任意 OAuth/OIDC 应用，内置 GitHub / Google / Microsoft / Discord / Linux.do / OIDC 模板；支持自定义图标 URL
- **GitHub 账号天数限制**：当存在 `provider_id=github` 的应用时，可限制最短注册天数；未达标会进入专门提示页，不会创建本地账号
- **多根域名支持**：每个根域名使用独立 Cloudflare API Token，命名为 `<域名点换下划线>_CLOUDFLARE_API_TOKEN`
- **记录数量与子域名限制**：全局 `max_records_per_user` / `min_subdomain_length`；可对单用户覆盖记录上限。超级管理员与管理员创建记录时无上限，也不受最小子域名长度限制
- **D1 持久化**：用户、会话、DNS 归属、验证码、设置、邀请码、OAuth 应用均存 Cloudflare D1
- **GitHub Actions 一键部署**：自动创建 D1、应用迁移、注入 secrets/vars 并部署 Worker

## 技术栈

- 运行时：Cloudflare Workers（`nodejs_compat`）
- Web 框架：Hono（JSX SSR）
- 鉴权：better-auth（邮箱密码 + `genericOAuth`）
- 存储：Cloudflare D1（SQLite）
- 邮件：Resend HTTP API

## 前置要求

- Node.js 18+
- pnpm
- Cloudflare 账户，并已将至少一个根域名接入 Cloudflare DNS
- 每个根域名一份具有 DNS 编辑权限的 Cloudflare API Token

## 本地开发

1. 安装依赖：

```txt
pnpm install
```

2. 创建 D1 数据库（首次）：

```txt
pnpm wrangler d1 create mc-server-hide-port-tool-db
```

将返回的 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`（替换 `REPLACE_WITH_D1_DATABASE_ID`）。

3. 应用迁移：

```txt
pnpm wrangler d1 migrations apply mc-server-hide-port-tool-db --local
```

迁移清单：

- `0000_init.sql` — better-auth：`user` / `session` / `account` / `verification`
- `0001_admin.sql` — `user.role`，以及 `dns_record` / `settings` / `email_verification`
- `0002_super_admin_and_limits.sql` — `super_admin` / `record_limit`，以及全局记录/子域名限制
- `0003_invite_codes.sql` — 邀请码
- `0004_oauth_providers.sql` — 通用 OAuth 应用表
- `0005_oauth_unify_github.sql` — OAuth `icon_url`；注册模式 `github` 归一为 `oauth`
- `0006_schema_hardening.sql` — 唯一索引、冗余索引清理、过期字段索引

4. 复制 `.dev.vars.example` 为 `.dev.vars` 并填写：

```txt
example_com_CLOUDFLARE_API_TOKEN=...
example_net_CLOUDFLARE_API_TOKEN=...
DOMAINS=["example.com","example.net"]
BETTER_AUTH_SECRET=openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:8787
```

> 生产环境请用 `wrangler secret put ...` 注入密钥，不要写进 `wrangler.jsonc`。
>
> OAuth（含 GitHub）**不走环境变量**，请在管理后台「OAuth 登录应用」中配置。

5. 启动开发服务器：

```txt
pnpm dev
```

访问 `http://localhost:8787`：

- **首次启动**（无用户）跳转 `/setup` 创建管理员
- **之后未登录**跳转 `/login`；登录后普通用户管理自己的 DNS，管理员可进 `/admin`

## 部署到生产

```txt
pnpm wrangler d1 migrations apply mc-server-hide-port-tool-db --remote
pnpm wrangler secret put example_com_CLOUDFLARE_API_TOKEN
pnpm wrangler secret put example_net_CLOUDFLARE_API_TOKEN
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm deploy
```

部署后完成 onboarding，再到 `/admin` 配置注册方式、邀请码、Resend、OAuth、GitHub 天数限制等。

## 部署方法

- **方式一：本地/服务器手动部署** — 见上方，或完整步骤 [`docs/deploy-local.md`](docs/deploy-local.md)
- **方式二：GitHub Actions 一键部署（推荐）** — 见 [`docs/deploy-github-actions.md`](docs/deploy-github-actions.md)

### 变量对照

| 变量 | 本地部署 | GitHub Actions 部署 |
|---|---|---|
| `<域名点换下划线>_CLOUDFLARE_API_TOKEN` | `.dev.vars` 或 `wrangler secret put` | 汇总到仓库 secret `CLOUDFLARE_DOMAINS_API_TOKEN`，CI 解析后注入 |
| `DOMAINS` | `.dev.vars` / `wrangler.jsonc` vars | 通常由 CI 从 `CLOUDFLARE_DOMAINS_API_TOKEN` 派生 |
| `BETTER_AUTH_SECRET` | `wrangler secret put` 或 `.dev.vars` | 仓库 secret |
| `BETTER_AUTH_URL` | `.dev.vars` / vars | 仓库 secret（注入为 Worker var） |
| OAuth Client ID/Secret | 管理后台写入 D1 | 同上（不要再配置 `GITHUB_CLIENT_*`） |

## 管理后台能力

| 模块 | 说明 |
|---|---|
| 注册设置 | 开关注册；模式 `email` / `oauth` / `both`；GitHub 最短注册天数（仅 `provider_id=github`） |
| 邀请码 | 开启 `invite_required` 后，仅管理员/超级管理员可生成 |
| 邮箱白/黑名单 | 按邮箱后缀限制注册 |
| Resend | 邮箱验证码开关与发件配置 |
| 记录限制 | 全局每用户记录上限、最小子域名长度；可覆盖单用户上限 |
| 用户管理 | 创建用户；仅超级管理员可升降管理员 |
| OAuth 登录应用 | 添加/编辑/启停/删除第三方 OAuth；支持模板与图标 URL |

### OAuth 配置要点

1. 在管理后台「OAuth 登录应用」中添加应用，或先选模板再填 Client ID/Secret。
2. 第三方回调地址：

```txt
BETTER_AUTH_URL/api/auth/oauth2/callback/<provider_id>
```

GitHub 示例：

```txt
https://your-domain.example/api/auth/oauth2/callback/github
```

3. 若启用 GitHub 天数限制，`provider_id` 必须是 `github`。
4. 注册模式：
   - `email`：仅邮箱
   - `oauth`：仅 OAuth
   - `both`：邮箱 + OAuth
   - 旧值 `github` 读取时会归一为 `oauth`
5. 未满足 GitHub 天数要求时，会跳转到 `/register/github-age-rejected`，不会创建本地账号。

## 项目结构

```txt
src/
  index.tsx                           # 路由组装入口
  routes/
    auth.tsx                          # 登录/注册/OAuth/setup
    dns.tsx                           # 用户 DNS API 与删除
    admin.tsx                         # 管理后台
  lib/
    http.ts                           # 重定向/Cookie/CSV 等通用辅助
    invite.ts                         # 邀请码校验与消费
  auth.ts                             # better-auth + genericOAuth
  services/
    settings.ts                       # 全局设置（带短缓存）
    dns-records.ts                    # DNS 记录与用户权限业务
    invite-codes.ts                   # 邀请码
    oauth-providers.ts                # OAuth CRUD / 模板 / genericOAuth 配置（带短缓存）
    email-verification.ts             # 注册验证码哈希 + 待注册密码密封
    request-cache.ts                  # settings / oauth 短缓存
    cloudflare-dns.ts                 # Cloudflare DNS API
    github.ts                         # GitHub 用户信息与天数校验
    mailer.ts                         # Resend 发信
  views/
    LoginView.tsx / RegisterView.tsx
    GitHubAgeRejectedView.tsx
    AdminView.tsx
    IndexView.tsx / SetupView.tsx / VerifyEmailView.tsx / Layout.tsx
public/static/
  main.js
scripts/
  ...
.github/workflows/
  deploy.yml
docs/
  deploy-local.md
  deploy-github-actions.md
migrations/
  0000_init.sql
  0001_admin.sql
  0002_super_admin_and_limits.sql
  0003_invite_codes.sql
  0004_oauth_providers.sql
  0005_oauth_unify_github.sql
  0006_schema_hardening.sql
```

## 权限与限制摘要

- 超级管理员 / 管理员创建 DNS 记录时**无上限**，并忽略全局 `min_subdomain_length`
- 仅超级管理员可提升/降级管理员；普通管理员不能降级/删除管理员，也不能操作超级管理员
- 邀请码仅在开启邀请注册后生效；生成权限限管理员与超级管理员
- OAuth 应用保存在 D1 表 `oauth_provider`，运行时注入 better-auth `genericOAuth`
- `dns_record.host_name` 与 `account(providerId, accountId)` 有唯一约束，避免重复绑定
- 邮箱验证流程中的待注册密码不会明文落库（使用 `BETTER_AUTH_SECRET` 密封）
