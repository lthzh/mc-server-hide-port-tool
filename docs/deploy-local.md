# 本地 / 服务器部署

适用：首次部署、调试、不方便用 GitHub Actions 的环境。

> 若选 GitHub Actions 一键部署，请改阅 [`deploy-github-actions.md`](deploy-github-actions.md)。

## 前置

- 安装 wrangler（已随 devDependencies 安装）：`pnpm install`
- Cloudflare 账户，并已添加至少一个根域名到 Cloudflare DNS
- 每个根域名一份具有 DNS 编辑权限的 Cloudflare API Token

## 创建 D1 数据库（首次）

```txt
pnpm wrangler d1 create mc-server-hide-port-tool-db
```

将控制台返回的 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id` 字段（替换 `REPLACE_WITH_D1_DATABASE_ID`）。

> 也可以在 `.dev.vars` 配好后用 `pnpm wrangler d1 list` 查看已有 D1 的 UUID。

## 应用迁移

```txt
pnpm wrangler d1 migrations apply mc-server-hide-port-tool-db --remote
```

迁移清单：

- `0000_init.sql` — better-auth 的 `user` / `session` / `account` / `verification` 四张表
- `0001_admin.sql` — `user` 表加 `role` 列，新增 `dns_record` / `settings` / `email_verification` 三张表
- `0002_super_admin_and_limits.sql` — `user` 表加 `super_admin` / `record_limit` 列；`settings` 表加 `max_records_per_user` / `min_subdomain_length`
- `0003_invite_codes.sql` — 邀请码表
- `0004_oauth_providers.sql` — 通用 OAuth 应用配置表
- `0005_oauth_unify_github.sql` — OAuth 增加 `icon_url`；注册模式 `github` 归一为 `oauth`

本地开发用 `--local` 应用同一套迁移。

## 配置本地 `.dev.vars`（或生产 Worker secrets）

### 本地开发

复制 `.dev.vars.example` 为 `.dev.vars` 并填写。每个根域名使用一个独立的 Cloudflare API Token，环境变量名为 `<域名中的点替换为下划线>_CLOUDFLARE_API_TOKEN`：

```
example_com_CLOUDFLARE_API_TOKEN=...
example_net_CLOUDFLARE_API_TOKEN=...
303302_xyz_CLOUDFLARE_API_TOKEN=...
DOMAINS=["example.com","example.net","303302.xyz"]
BETTER_AUTH_SECRET=openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:8787
```

> 生产环境请用 `wrangler secret put <NAME>` 设置密钥，切勿写入 wrangler.jsonc。
>
> **不要**再配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。OAuth（含 GitHub）统一在管理后台配置。

### 域名列表的本地写法

也可把域名列表写进 `wrangler.jsonc` 的 `vars` 字段：

```jsonc
{
  "vars": {
    "APP_NAME": "hide-port-tool",
    "DOMAINS": "[\"example.com\",\"example.net\"]",
    "BETTER_AUTH_URL": "https://mc.example.com"
  }
}
```

## 注入生产 secrets 并部署

```txt
pnpm wrangler secret put example_com_CLOUDFLARE_API_TOKEN
pnpm wrangler secret put example_net_CLOUDFLARE_API_TOKEN
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm deploy
```

部署完成后访问站点会进入 onboarding 流程；创建管理员后即可在 `/admin` 后台配置：

- 注册开关与模式（`email` / `oauth` / `both`）
- 邀请码
- 邮箱白/黑名单、Resend
- OAuth 登录应用（GitHub / 其他第三方）
- GitHub 账号最短注册天数（仅当存在 `provider_id=github` 的应用时生效）
- 每用户记录上限、最小子域名长度

## 环境变量说明

| 名称 | 用途 | 必需 | 备注 |
|---|---|---|---|
| `<域名点换下划线>_CLOUDFLARE_API_TOKEN` | 对应根域名的 Cloudflare DNS API Token | 是 | 例如 `example_com_CLOUDFLARE_API_TOKEN` |
| `DOMAINS` | 允许使用的根域名 JSON 数组 | 是 | 与 token 覆盖范围一致 |
| `BETTER_AUTH_SECRET` | better-auth 签名密钥 | 是 | 建议 `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | 站点对外 URL | 是 | 须与浏览器访问域名一致，OAuth 回调依赖它 |
| `APP_NAME` | 应用名 | 否 | 默认 `hide-port-tool` |

代码中通过 `(env as Record<string, string|undefined>)[key]` 动态读取域名 token。键名以数字开头不影响 `wrangler secret put` 或 `.dev.vars`，仅在 GitHub Actions env 受限——CI 部署见 [`deploy-github-actions.md`](deploy-github-actions.md)。

## 配置 OAuth（部署后）

1. 使用超级管理员/管理员登录 → 打开「管理后台」→「OAuth 登录应用」。
2. 选择模板（如 GitHub）或自定义填写端点，填入 Client ID / Secret，可选填写图标 URL。
3. 在第三方 OAuth 控制台把回调地址设为：

```txt
{BETTER_AUTH_URL}/api/auth/oauth2/callback/{provider_id}
```

GitHub 示例：

```txt
https://mc.example.com/api/auth/oauth2/callback/github
```

4. 若需要 GitHub 账号天数限制：
   - 后台注册设置中填写「GitHub 账号最短注册天数」
   - OAuth 应用的 `provider_id` 必须是 `github`
