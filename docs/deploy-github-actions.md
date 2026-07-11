# GitHub Actions 一键部署（推荐生产环境）

在仓库 **Actions** 页面选择 *Deploy to Cloudflare Workers* → **Run workflow** 即可。

## 流程概览

1. 安装依赖
2. 解析 `CLOUDFLARE_DOMAINS_API_TOKEN` → 域名列表 + 各域名 token
3. 创建/对齐 D1，写回 `database_id`
4. 应用全部 D1 迁移（含邀请码、OAuth 表）
5. 部署 Worker，注入 vars / secrets
6. 为每个根域名 `wrangler secret put` 对应 DNS token
7. 绑定 `BETTER_AUTH_URL` 对应的 custom domain（若已配置）

## 为什么用 `CLOUDFLARE_DOMAINS_API_TOKEN`

GitHub Actions 中 secret 名必须仅含 `[A-Z0-9_]` 且不能以数字开头，因此**根域名 Token 不再用 `*_CLOUDFLARE_API_TOKEN` 形式直接作为 GitHub secret 名**，而是统一汇总到 `CLOUDFLARE_DOMAINS_API_TOKEN`，由 CI 解析后再以 `<域名点换下划线>_CLOUDFLARE_API_TOKEN`（小写）注入到 Worker（与运行时代码读取的命名一致）。

## 需要配置的仓库 Secrets

| GitHub Secret 名 | 是否敏感 | 必需 | 对应的 Worker 变量 | 说明 |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 是 | 是 | （部署用） | 账户级部署 Token，需 Workers + D1 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | 否 | 是 | （部署用） | Cloudflare Account ID |
| `CLOUDFLARE_DOMAINS_API_TOKEN` | 是 | 是 | 各 `<domain>_CLOUDFLARE_API_TOKEN` + 派生 `DOMAINS` | 见下方格式 |
| `BETTER_AUTH_SECRET` | 是 | 是 | secret `BETTER_AUTH_SECRET` | 建议 `openssl rand -base64 32` 生成 |
| `BETTER_AUTH_URL` | 否 | 建议 | var `BETTER_AUTH_URL` | 站点对外 URL；OAuth 回调依赖此值 |
| `DOMAINS` | 否 | 否 | （仅一致性校验参考） | 若设置，CI 校验其列出的域名是否都被 `CLOUDFLARE_DOMAINS_API_TOKEN` 覆盖；缺漏只警告 |

> CI 会探测每个 secret 是否非空，未配置的会自动跳过，不会因缺值而失败（必需项除外）。
>
> `APP_NAME` 已在 `wrangler.jsonc.vars` 中默认 `hide-port-tool`，无需在 CI 设置。
>
> **不再需要** `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。GitHub 与其它 OAuth 应用在部署后由管理后台写入 D1。

## `CLOUDFLARE_DOMAINS_API_TOKEN` 详细格式

单一变量汇总所有根域名的 Cloudflare DNS API Token：

```
<域名1>:<token1>,<域名2>:<token2>,...
```

### 例子

仓库 secret `CLOUDFLARE_DOMAINS_API_TOKEN` 的值：

```
303302.xyz:abc123_your_token_here,example.com:def456_your_token_here
```

### CI 解析后的行为

1. **token 注入**：每个域名前的 `:` 切分为「域名 / token」，CI 把每个 token 以 `<域名中的点→下划线>_CLOUDFLARE_API_TOKEN`（小写）的 secret 名循环 `wrangler secret put` 注入 Worker。例：`303302.xyz` → Worker secret `303302_xyz_CLOUDFLARE_API_TOKEN`。
2. **DOMAINS 派生**：CI 把解析出的域名清单覆盖到 Worker 的 `DOMAINS` 普通环境变量（`["303302.xyz","example.com"]` 形式），无需单独设置 `DOMAINS` secret。

最终运行时的 `DOMAINS` 中每个根域名都必须有对应 token，否则该域名创建 DNS 记录时会因找不到 token 而失败。

## 新增根域名

把对应的 `<域名>:<Token>` 拼接到 `CLOUDFLARE_DOMAINS_API_TOKEN` 末尾（英文 `,` 分隔）即可。CI 自动把新域名加入 Worker 的 `DOMAINS` 变量并注入对应 Token，无需改 workflow 或新增单独 secret。

## 域名清单的单一事实来源

| 来源 | 是否生效 | 备注 |
|---|---|---|
| `CLOUDFLARE_DOMAINS_API_TOKEN` 中的域名 | 是，派生为最终 `DOMAINS` | 无论是否设置 `DOMAINS` secret，CI 都以此为准生成 Worker 的 `DOMAINS` 变量 |
| `DOMAINS` secret | 仅一致性校验 | 若设置，CI 检查其每一条是否都被 `CLOUDFLARE_DOMAINS_API_TOKEN` 覆盖；缺漏只在日志警告，不阻断部署 |

## 示例：单域名最小配置

仓库 Secrets 配置：

| Secret 名 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `<部署用账户级 Token，含 Workers + D1 权限>` |
| `CLOUDFLARE_ACCOUNT_ID` | `<你的 Account ID>` |
| `CLOUDFLARE_DOMAINS_API_TOKEN` | `303302.xyz:<该域名 DNS 编辑权限 Token>` |
| `BETTER_AUTH_URL` | `https://mc.303302.xyz` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` 生成的随机串 |

CI 部署后 Worker 拥有：

- 明文 var `DOMAINS = ["303302.xyz"]`、`BETTER_AUTH_URL = https://mc.303302.xyz`
- secret `303302_xyz_CLOUDFLARE_API_TOKEN`、`BETTER_AUTH_SECRET`
- custom domain `mc.303302.xyz` 绑定到该 Worker（DNS + 证书由 Cloudflare 自动管理）

## 示例：双域名 + 后台配置 OAuth

仓库 Secrets 配置：

| Secret 名 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `<账户级部署 Token>` |
| `CLOUDFLARE_ACCOUNT_ID` | `<Account ID>` |
| `CLOUDFLARE_DOMAINS_API_TOKEN` | `303302.xyz:tok_A,example.com:tok_B` |
| `BETTER_AUTH_URL` | `https://mc.303302.xyz` |
| `BETTER_AUTH_SECRET` | `<32 位随机串>` |

CI 部署后 Worker 拥有：

- 明文 var `DOMAINS = ["303302.xyz","example.com"]`、`BETTER_AUTH_URL`
- secret `303302_xyz_CLOUDFLARE_API_TOKEN`、`example_com_CLOUDFLARE_API_TOKEN`、`BETTER_AUTH_SECRET`
- custom domain `mc.303302.xyz` 绑定到该 Worker

### 部署后配置 OAuth

1. 用 onboarding 创建的超级管理员登录站点。
2. 打开管理后台 → **OAuth 登录应用**。
3. 选择模板（GitHub / Google / Microsoft / Discord / Linux.do / Generic OIDC）或自定义端点。
4. 在第三方平台登记回调地址：

```txt
https://mc.303302.xyz/api/auth/oauth2/callback/<provider_id>
```

GitHub 的 `provider_id` 请使用 `github`，回调即为：

```txt
https://mc.303302.xyz/api/auth/oauth2/callback/github
```

5. （可选）在注册设置中开启邀请码、配置 GitHub 最短注册天数、选择 `email` / `oauth` / `both` 注册模式。

## 手动触发

在 **Actions** 页面选择 *Deploy to Cloudflare Workers* → **Run workflow** 即可。

> GitHub / 第三方 OAuth **不再**通过仓库 secret 注入。部署后请在管理后台添加 OAuth 应用。
