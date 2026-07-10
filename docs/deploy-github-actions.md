# GitHub Actions 部署说明

仓库根目录的 `.github/workflows/deploy.yml` 提供自动部署 Worker 的能力：在 Actions 页面手动触发即可完成「创建 D1 → 应用迁移 → 部署 Worker → 注入 secrets/vars」全套流程。

## 需要配置的仓库 Secrets

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加以下 secret：

### 1. Cloudflare 部署用账号凭据（2 个）

| Secret 名 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 用于部署 Worker、操作 D1。需要在 Cloudflare 后台生成，权限包含 *Workers Scripts: Edit*、*D1: Edit*。 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID，在 dashboard 右下角复制。 |

### 2. 业务环境变量

| Secret 名 | 是否敏感 | 说明 |
|---|---|---|
| `DOMAINS` | ❌ 明文 var | JSON 数组字符串，如 `["303302.xyz","example.com"]` |
| `BETTER_AUTH_URL` | ❌ 明文 var | worker 对外访问 URL；若指向非 `*.workers.dev` 的自有域名，CI 会自动把它作为 custom domain 绑定到 worker |
| `BETTER_AUTH_SECRET` | ✅ secret | better-auth 会话签名密钥 |
| `CLOUDFLARE_DOMAINS_API_TOKEN` | ✅ secret | 汇总所有根域名 Cloudflare API Token 的单变量，格式见下方 |
| `GITHUB_CLIENT_ID` | ✅ secret（可选） | 仅在后台开启 GitHub 注册时需要，未设置则 CI 自动跳过 |
| `GITHUB_CLIENT_SECRET` | ✅ secret（可选） | 同上 |

CI 会探测每个 secret 是否非空，未配置的会自动跳过，不会因缺值而失败。

### `CLOUDFLARE_DOMAINS_API_TOKEN` 格式

所有根域名的 Cloudflare DNS API Token 用一个变量汇总：

```
<域名1>:<token1>,<域名2>:<token2>,...
```

例如，`CLOUDFLARE_DOMAINS_API_TOKEN` 的值：
```
303302.xyz:abc123_your_token_here,example.com:def456_your_token_here
```

- `:` 之前是该根域名，以后保持小写原样（如 `303302.xyz`）。
- `:` 之后是 Cloudflare API Token，需具有该域名 DNS 编辑权限。
- 域名之间用英文逗号 `,` 分隔。

CI 会用 `scripts/parse_domain_tokens.py` 解析，再在 `postCommands` 中用 `scripts/put_domain_secrets.py` 把每个 token 以 `<域名点换下划线>_CLOUDFLARE_API_TOKEN`（小写）的 secret 名循环 `wrangler secret put` 注入到 Worker，与运行时代码读取的命名一致。

> **必须保证 `DOMAINS` 中列出的每个根域名都出现在 `CLOUDFLARE_DOMAINS_API_TOKEN` 中**；缺漏会让该域名创建 DNS 记录时找不到 token 而失败，CI 会在日志里给出明确警告。

### 新增根域名

把新域名加进 `DOMAINS`，再把对应的 Token 拼接到 `CLOUDFLARE_DOMAINS_API_TOKEN` 末尾（`,` 分隔），无需改 workflow 或加新 secret。

## 流程

1. 检出代码、安装 pnpm 依赖
2. **Build dynamic var/secret lists**：解析 `CLOUDFLARE_DOMAINS_API_TOKEN`，生成每根域名的 wrangler secret 名 + JSON 值文件；同时探测各 secret 是否非空，构建 vars/secrets 名单
3. **幂等创建/查找 D1**：通过 Cloudflare API 列出账户下 D1，若不存在则 POST 创建，并把 `database_id` 写回 `wrangler.jsonc`（避免本地占位符导致部署失败）
4. **patch custom domain**：若 `BETTER_AUTH_URL` 指向自有域名，写入 `wrangler.jsonc` 的 `routes: [{ pattern, custom_domain: true }]`，由 `wrangler deploy` 自动创建 custom domain（含 DNS 与证书）
5. `wrangler d1 migrations apply hide-port-tool-db --remote` 应用迁移到远端 D1
6. `wrangler deploy --minify` 部署 Worker（vars 走 `--var` 注入，secret 走 wrangler-action 的 `secrets` 字段）
7. `postCommands` 循环 `wrangler secret put` 把每个根域名 token 写入 Worker

## 手动触发

在 **Actions** 页面选择 *Deploy to Cloudflare Workers* → **Run workflow** 即可。
