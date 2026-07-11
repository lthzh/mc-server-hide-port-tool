# Minecraft 端口隐藏工具

基于 Cloudflare Workers + Hono + better-auth 实现的 Minecraft 端口隐藏工具。通过 Cloudflare DNS SRV 记录让玩家无需输入端口号即可连接服务器。

主要特性：

- **首次启动自动 onboarding**：检测到无用户时强制跳转 `/setup` 创建首个管理员并直接登录；首个用户自动被标记为「超级管理员」（不可被其他管理员降级或删除）
- **多角色权限**：普通用户可创建/删除自己的 DNS 记录；管理员可访问后台管理所有用户、所有记录和全局设置；管理员可在后台手动创建用户（无需走注册页）
- **可配置的注册流程**：管理员可在后台开启/关闭注册，选择「邮箱 / OAuth / 邮箱+OAuth」三种模式之一
- **邀请码注册（可选）**：开启后邮箱与 OAuth 注册均需邀请码；仅管理员/超级管理员可生成邀请码
- **邮箱后缀白/黑名单**：可同时启用，按后缀匹配（支持子域后缀，如填 `gmail.com` 会同时匹配 `mail.gmail.com`）
- **邮箱验证码**：启用 Resend 后，邮箱注册需先收到 6 位验证码；未启用时输入邮箱密码直接完成注册
- **通用 OAuth 登录/注册**：在管理后台添加任意 OAuth/OIDC 应用（含 GitHub、Google、Discord、Linux.do 等模板）；GitHub 可额外限定账号最短注册天数
- **多根域名支持**：每个根域名使用独立的 Cloudflare API Token（按 `<域名点换下划线>_CLOUDFLARE_API_TOKEN` 命名），可对应不同 Cloudflare 账户
- **记录数量上限**：全局 `max_records_per_user` 控制默认每用户可创建 DNS 记录数；管理员可在后台对单个用户覆盖该上限。超级管理员与管理员创建记录时无上限，也不受最小子域名长度限制
- **子域名最小字符长度**：全局 `min_subdomain_length` 限制子域名最短字符数（例如设为 4 时只能用 `1111.example.com` 或更长）
- **D1 持久化**：用户、会话、DNS 记录归属、验证码、全局设置、邀请码、OAuth 应用全部存于 Cloudflare D1
- **GitHub Actions 一键部署**：CI 自动创建 D1、应用迁移、注入 secrets/vars 并部署 Worker，详见 [部署方法](#部署方法)

## 技术栈

- 运行时：Cloudflare Workers（`nodejs_compat`）
- Web 框架：Hono（JSX SSR）
- 鉴权：better-auth（邮箱密码 + `genericOAuth` 插件）
- 存储：Cloudflare D1（SQLite）
- 邮件：Resend HTTP API（Workers 不支持 TCP，无法直连 SMTP）

## 前置要求

- Node.js 18+
- pnpm
- Cloudflare 账户，并已添加至少一个根域名到 Cloudflare DNS
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

将控制台返回的 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id` 字段（替换 `REPLACE_WITH_D1_DATABASE_ID`）。

3. 应用迁移：

```txt
pnpm wrangler d1 migrations apply mc-server-hide-port-tool-db --local
```

迁移建表清单：
- `0000_init.sql` — better-auth 的 `user` / `session` / `account` / `verification` 四张表
- `0001_admin.sql` — `user` 表加 `role` 列，新增 `dns_record` / `settings` / `email_verification` 三张表
- `0002_super_admin_and_limits.sql` — `user` 表加 `super_admin` / `record_limit` 列；`settings` 表加 `max_records_per_user` / `min_subdomain_length`
- `0003_invite_codes.sql` — 邀请码表
- `0004_oauth_providers.sql` — 通用 OAuth 应用配置表
- `0005_oauth_unify_github.sql` — OAuth 增加 `icon_url`；注册模式 `github` 归一为 `oauth`

4. 复制 `.dev.vars.example` 为 `.dev.vars` 并填写。每个根域名使用一个独立的 Cloudflare API Token，环境变量名为 `<域名中的点替换为下划线>_CLOUDFLARE_API_TOKEN`：

```
example_com_CLOUDFLARE_API_TOKEN=...
example_net_CLOUDFLARE_API_TOKEN=...
DOMAINS=["example.com","example.net"]
BETTER_AUTH_SECRET=openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:8787
```

> 生产环境请用 `wrangler secret put BETTER_AUTH_SECRET` 等命令设置密钥，切勿写入 wrangler.jsonc。
>
> OAuth（含 GitHub）**不在环境变量中配置**，请登录后在管理后台的「OAuth 登录应用」中添加。

5. 启动开发服务器：

```txt
pnpm dev
```

浏览器访问 `http://localhost:8787`：

- **首次启动**（user 表为空）自动跳转 `/setup`，创建第一个管理员账户后直接登录进入主页
- **后续启动**未登录则跳 `/login`，登录后普通用户看自己的 DNS 记录并创建/删除；管理员额外可看到「管理后台」入口

## 部署到生产

```txt
pnpm wrangler d1 migrations apply mc-server-hide-port-tool-db --remote
pnpm wrangler secret put example_com_CLOUDFLARE_API_TOKEN
pnpm wrangler secret put example_net_CLOUDFLARE_API_TOKEN    # 多域名逐个 put
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm deploy
```

部署完成后访问站点会进入 onboarding 流程；创建管理员后即可在 `/admin` 后台配置注册方式、邮箱白名单、Resend、邀请码、OAuth 应用、GitHub 账号年限等。

## 部署方法

- **方式一：本地 / 服务器手动部署** — 见上方「部署到生产」，或完整步骤 [`docs/deploy-local.md`](docs/deploy-local.md)
- **方式二：GitHub Actions 一键部署**（推荐生产环境）— 在 Actions 页面手动触发即可自动完成「创建 D1 → 解析根域名 token → 应用迁移 → 部署 Worker → 注入 secrets/vars → 绑定 custom domain」。详见 [`docs/deploy-github-actions.md`](docs/deploy-github-actions.md)

### 变量对照

| 变量 | 本地部署 | GitHub Actions 部署 |
|---|---|---|
| `<域名点换下划线>_CLOUDFLARE_API_TOKEN` | `.dev.vars` 或 `wrangler secret put` | 汇总到仓库 secret `CLOUDFLARE_DOMAINS_API_TOKEN`，CI 解析后注入 |
| `DOMAINS` | `.dev.vars` / `wrangler.jsonc` vars | 通常由 CI 从 `CLOUDFLARE_DOMAINS_API_TOKEN` 派生 |
| `BETTER_AUTH_SECRET` | `wrangler secret put` 或 `.dev.vars` | 仓库 secret |
| `BETTER_AUTH_URL` | `.dev.vars` / vars | 仓库 secret（会注入为 Worker var） |
| OAuth Client ID/Secret | 管理后台「OAuth 登录应用」写入 D1 | 同上（**不要**再配置 `GITHUB_CLIENT_*` 环境变量） |

## 管理后台能力

| 模块 | 说明 |
|---|---|
| 注册设置 | 开关注册；模式 `email` / `oauth` / `both`；GitHub 账号最短注册天数（仅 `provider_id=github` 生效） |
| 邀请码 | 开启 `invite_required` 后，仅管理员/超级管理员可生成邀请码 |
| 邮箱白/黑名单 | 按邮箱后缀限制注册 |
| Resend | 邮箱验证码开关与发件配置 |
| 记录限制 | 全局每用户记录上限、最小子域名长度；可对单用户覆盖记录上限 |
| 用户管理 | 创建用户、升降管理员（仅超级管理员可操作管理员） |
| OAuth 登录应用 | 添加/编辑/启停/删除第三方 OAuth；支持模板（GitHub/Google/Microsoft/Discord/Linux.do/OIDC）与自定义图标 URL |

### OAuth 配置要点

1. 在管理后台「OAuth 登录应用」中添加应用，或先选模板再填 Client ID/Secret。
2. 第三方平台回调地址填写：

```txt
BETTER_AUTH_URL/api/auth/oauth2/callback/<provider_id>
```

例如 GitHub：

```txt
https://your-domain.example/api/auth/oauth2/callback/github
```

3. 若要启用 GitHub 账号天数限制，`provider_id` 必须为 `github`（模板会自动填入）。
4. 注册模式：
   - `email`：仅邮箱
   - `oauth`：仅 OAuth
   - `both`：邮箱 + OAuth
   - 旧值 `github` 读取时会归一为 `oauth`

## 项目结构

```
src/
  index.tsx                           # Hono 路由与页面 SSR
  auth.ts                             # better-auth + genericOAuth
  services/
    settings.ts                       # 全局设置读写
    dns-records.ts                    # DNS 记录业务
    invite-codes.ts                   # 邀请码
    oauth-providers.ts                # OAuth 应用 CRUD / 模板 / genericOAuth 配置
    github.ts                         # 调用 GitHub /user 取 created_at 校验
    mailer.ts                         # Resend 发信
  views/
    LoginView.tsx / RegisterView.tsx  # 登录注册（含 OAuth 按钮与图标）
    AdminView.tsx                     # 管理后台
    IndexView.tsx / SetupView.tsx ...
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
```

## 权限与限制摘要

- 超级管理员 / 管理员创建 DNS 记录时**无上限**，且忽略全局 `min_subdomain_length`。
- 仅超级管理员可提升/降级管理员；普通管理员不能降级/删除管理员，也不能操作超级管理员。
- 邀请码仅在开启邀请注册后生效；生成权限限管理员与超级管理员。
- OAuth 应用配置存 D1 表 `oauth_provider`，运行时注入 better-auth `genericOAuth`。
