# 首次初始化认领与并发安全设计

日期：2026-07-15
状态：已批准，待实施

## 1. 背景与问题

项目当前通过 `POST /api/auth/setup` 创建第一个管理员。现有流程先查询用户数量，随后调用 Better Auth 创建邮箱用户，最后重新列出用户并根据排序结果把新用户提升为管理员和超级管理员。

该流程存在四类相互关联的问题：

1. **检查后执行竞态**：两个并发请求可以同时观察到用户数量为零，随后都进入注册流程。
2. **权限事后提升**：用户首先以普通用户身份插入，之后才执行角色更新；任一中间失败都可能留下非管理员首用户。
3. **其他注册入口可抢占首用户**：默认设置允许邮箱注册。空数据库阶段，普通邮箱注册或 OAuth 新用户创建可能先于 `/setup` 写入用户，使初始化入口永久关闭。
4. **D1 上缺少注册事务**：Better Auth 1.6.23 的邮箱注册虽然调用事务包装器，但其 D1 Kysely 适配器没有交互式事务实现。`user` 与 `credential account` 实际是顺序写入，Worker 中断或第二步失败可能留下无凭据用户。

因此，本整改不能只增加一次 `COUNT(user)` 复查或进程内互斥锁。安全边界必须下沉到 D1 原子状态变更和 Better Auth 的用户创建 Hook。

## 2. 目标

本整改必须保证：

1. 一个全新部署最多只有一个请求能够认领首次初始化。
2. 初始化未完成时，只有持有服务器内部有效认领上下文的 setup 流程可以创建用户。
3. 首个用户在插入数据库时已经是管理员和超级管理员，不依赖事后提升。
4. `credential account` 创建成功即代表初始化完成，即使 Worker 随后中断也不能重新开放初始化。
5. `user` 已创建但 credential 未创建时，可以在安全隔离后恢复，不会永久锁死部署。
6. 认领、完成、清理和 credential 插入之间的并发只能收敛到合法终态。
7. 现有已初始化部署升级迁移后不得重新暴露首次管理员认领入口。
8. 初始化完成后，现有邮箱注册、OAuth 注册和管理员创建用户行为保持不变。
9. 认领凭据、邮箱、密码和原始异常不得进入日志、响应或非必要持久化存储。
10. Better Auth 版本继续精确固定为 `1.6.23`。

## 3. 非目标

本整改不包括：

- 为已有但缺少超级管理员的历史数据库提供公开自助恢复入口；这类数据库需要运维人员确认身份后手工处理。
- 改变管理员或超级管理员的日常权限模型。
- 改变密码哈希算法或自行实现 Better Auth 的登录协议。
- 引入 Durable Object、外部锁服务或新的部署组件。
- 重做 setup 页面视觉设计。
- 调整普通注册的邀请、邮箱验证或 OAuth intent 业务规则。

## 4. 方案选择

### 4.1 方案 A：只在 setup 路由增加互斥锁

该方案能缩小两个 setup 请求之间的竞态，但无法阻止普通注册抢占首用户，也无法安全处理 `user` 已写入而 credential 未写入的中断场景。因此不采用。

### 4.2 方案 B：D1 状态机、用户创建门禁和数据库完成触发器

该方案用 D1 单例状态记录初始化阶段，用条件更新原子认领，在 Better Auth 用户创建 Hook 中执行最终门禁并直接写入管理员字段，再由 credential 插入触发器完成初始化。异常和崩溃通过拥有者释放及超时协调恢复。

该方案复用 Better Auth 的密码哈希与账户写入逻辑，同时为 D1 缺少交互式事务的事实提供显式补偿机制，因此采用此方案。

### 4.3 方案 C：应用自行批量插入 user 和 account

D1 `batch()` 可以提供批量事务，但应用需要复制 Better Auth 的 credential schema、ID 和密码账户契约，升级耦合过高，因此不采用。

## 5. 数据模型

新增迁移：

`migrations/0011_first_setup_claim.sql`

迁移建立固定单行表 `first_setup`，逻辑字段如下：

| 字段 | 用途 |
| --- | --- |
| `id` | 固定为 `1`，确保全库只有一个初始化状态 |
| `status` | `open`、`claimed` 或 `completed` |
| `claim_token_hash` | 认领 token 的 SHA-256 哈希；仅 `claimed` 状态存在 |
| `claimed_at` | 认领时间，Unix 毫秒 |
| `claimed_user_id` | Hook 为本次认领分配并绑定的用户 ID |
| `completed_at` | credential 完成初始化的时间，Unix 毫秒 |

表必须使用约束保证状态字段组合合法：

- `open`：认领哈希、认领时间、用户 ID 和完成时间均为空。
- `claimed`：认领哈希和认领时间非空；用户 ID可以在用户创建 Hook 执行前暂时为空。
- `completed`：认领哈希为空且完成时间非空；`claimed_user_id` 保留为首个管理员 ID，便于审计和协调。

迁移初始化规则：

- `user` 表为空：插入 `open`。
- `user` 表已有任意用户：插入 `completed`，`completed_at` 使用迁移执行时间。

已有用户但没有超级管理员的历史部署也标记为 `completed`。不得在无人认证的公开网络上重新开放管理员认领。

数据库中只保存 SHA-256 哈希；明文 claim token 仅存在于当前 Worker 请求内存。

## 6. 状态机与不变量

```text
open
  └─ 原子认领且 user 表为空 ─> claimed

claimed
  ├─ Hook 原子绑定 user id ─> claimed
  ├─ credential 插入触发器 ─> completed
  ├─ 拥有者确认无 credential 后立即清理 ─> open
  └─ 超时协调确认无 credential 后清理 ─> open

completed
  └─ 永久保持 completed
```

核心不变量：

1. 任意时刻最多存在一个有效 claim。
2. `completed` 不允许通过应用逻辑回退为 `claimed` 或 `open`。
3. 初始化未完成时，无有效 setup claim 的用户创建必须失败。
4. setup 用户插入时必须同时满足 `role='admin'` 和 `super_admin=1`。
5. 只有认领用户的 credential account 可以把状态推进为 `completed`。
6. `open` 状态下不得残留由 setup claim 创建的孤儿用户。
7. 协调操作必须幂等。

## 7. 原子认领

新增服务模块：

`src/services/first-setup.ts`

setup 路由必须先完成无副作用的输入校验，随后才尝试认领。

认领过程：

1. 生成 32 字节密码学随机 token。
2. 计算 SHA-256 哈希。
3. 执行单条条件更新，将 `open` 改为 `claimed`。
4. 更新条件同时要求 `NOT EXISTS (SELECT 1 FROM user)`。
5. 使用 `RETURNING` 或 D1 变更计数确认是否获得认领权。

并发请求由 D1 的单条写操作串行化。只有一个请求可以把同一行从 `open` 改为 `claimed`。

认领失败后读取当前状态以返回稳定结果：

- `completed` 或数据库已有用户：`SETUP_DONE`。
- 未过期的 `claimed`：HTTP 409，`SETUP_IN_PROGRESS`，并可附带不包含敏感信息的 `Retry-After`。
- 检测到可协调的过期 claim：先执行协调，再最多重试一次认领。

不得通过无限循环或客户端提供的 token 重试。

## 8. Better Auth 用户创建门禁

扩展 `createAuth`，允许 setup 路由传入仅服务器内部可构造的 setup 上下文。该上下文包含本次请求内存中的明文 claim token，不来自公共请求头、Cookie、查询参数或 JSON body。

在 `databaseHooks.user.create.before` 中：

1. 如果不存在 setup 上下文：
   - 在分配用户 ID 前查询初始化状态；
   - 仅在状态为 `completed` 时允许普通用户创建；
   - `open` 或 `claimed` 时抛出固定的初始化未完成错误，避免未初始化阶段的拒绝请求消耗用户 ID。
2. 如果存在 setup 上下文：
   - 先校验 claim 哈希、`claimed` 状态、隔离有效期和空用户表；
   - 校验通过后才使用现有 `allocateNextUserId` 分配用户 ID；
   - 原子地在 `claimed_user_id IS NULL` 条件下绑定当前用户 ID；
   - 返回的用户数据直接包含 `role='admin'` 和 `super_admin=1`。
3. 初始化门禁通过后，正常用户创建才分配用户 ID。
4. OAuth registration intent 的现有授权逻辑在初始化门禁通过后继续执行。

setup 上下文和 OAuth registration intent 不应同时出现。若同时出现，必须失败关闭。

这将替换 setup 路由当前的以下逻辑：

- 注册成功后调用 `listAllUsers()`；
- 根据 `createdAt` 排序猜测首用户；
- 事后调用 `setUserRole()`；
- 事后调用 `setSuperAdmin()`。

## 9. credential 完成触发器

迁移新增 `AFTER INSERT ON account` 触发器。

仅在以下条件全部满足时更新 `first_setup`：

- 新账户 `providerId='credential'`；
- 当前状态为 `claimed`；
- `claimed_user_id` 等于新账户的 `userId`；
- 对应用户存在；
- 对应用户的 `role='admin'`；
- 对应用户的 `super_admin=1`。

触发器把状态设置为 `completed`、清除 claim 哈希并写入 `completed_at`。该更新与 credential 插入位于同一条 SQLite 写入事务中，因此 credential 成功存在时，即使 Worker 随后终止，也不会重新开放初始化。

应用服务还应提供幂等协调：如果发现认领用户已有 credential，但状态仍为 `claimed`，将其推进为 `completed`。这用于兼容触发器部署差异和恢复测试，不作为正常完成路径的唯一保障。

## 10. 失败释放与超时恢复

隔离期固定为 10 分钟。

### 10.1 当前拥有者立即释放

Better Auth 注册返回失败或抛出异常后，setup 路由使用本次明文 claim token 调用拥有者清理：

- claim 尚未绑定用户：直接恢复 `open`。
- 已绑定用户但没有 credential：删除该孤儿用户及其级联数据，再恢复 `open`。
- credential 已存在或状态已完成：不得删除用户或重新开放。

删除孤儿用户与恢复状态应通过 D1 `batch()` 执行，并在每条语句中重复 claim 哈希和状态条件，避免释放他人的认领。

### 10.2 超时协调

任何需要判断 setup 状态的入口都可以触发一次幂等协调，但不得在每个无关请求上执行昂贵清理。

对于超过 10 分钟的 `claimed` 状态：

1. 再次检查认领用户及其 credential。
2. credential 已存在：推进为 `completed`。
3. credential 不存在：在条件批处理中删除孤儿用户并恢复 `open`。
4. `claimed_user_id` 尚未绑定：直接恢复 `open`。

credential 插入与清理并发时，D1 写入串行化并由条件语句保证：

- credential 先提交：触发器完成初始化，清理条件失效；
- 清理先提交：用户被删除并恢复 `open`，随后 credential 插入因外键或用户缺失而失败。

合法终态只能是：

- 一个完整超级管理员和 `completed`；或
- 没有 setup 孤儿用户且状态为 `open`。

## 11. 路由和页面行为

### 11.1 setup 路由

`POST /api/auth/setup`：

1. CSRF/JSON 检查；
2. 输入校验；
3. 状态协调；
4. 原子认领；
5. 用服务器内部 setup 上下文创建 Better Auth 实例；
6. 调用邮箱注册；
7. 注册失败时执行拥有者清理；
8. 注册成功后单独执行登录；登录失败不回滚已完成的管理员账户。

### 11.2 普通注册入口

以下流程在初始化不是 `completed` 时必须在产生副作用前拒绝：

- 邮箱注册开始；
- 邮箱验证码确认并创建用户；
- OAuth 注册开始；
- OAuth 新用户 callback。

提前拒绝可以避免创建验证码、预留邀请码或 OAuth intent。Better Auth Hook 是最终防线，即使未来新增路由遗漏前置检查，也不得创建用户。

### 11.3 页面导航

页面路由使用 `first_setup.status` 作为初始化真相来源：

- `open` 或 `claimed`：根页面、登录页和注册页应引导至 `/setup`；
- `completed`：setup 页面重定向到正常应用入口。

`claimed` 页面可以正常展示 setup 表单，但提交会得到 `SETUP_IN_PROGRESS`。这样崩溃后的部署仍能进入可恢复路径，而不是因为已经存在孤儿 user 被永久重定向到登录页。

## 12. 错误与隐私

客户端只接收固定消息和错误码：

- `SETUP_DONE`
- `SETUP_IN_PROGRESS`
- `SETUP_NOT_READY`
- `SETUP_FAILED`

不向客户端反射 Better Auth、D1 或异常对象的原始消息。

新增初始化安全日志采用显式序列化安全事件，例如：

```ts
console.error(JSON.stringify(createFirstSetupSecurityEvent(error, { stage })))
```

事件仅允许包含：

- 固定事件类型；
- 固定错误代码；
- 固定阶段枚举；
- 时间戳。

不得包含：

- 姓名；
- 邮箱；
- 密码或密码哈希；
- 明文 claim token 或 claim 哈希；
- 请求体；
- Cookie；
- IP 或 User-Agent；
- 原始异常对象或堆栈。

## 13. 兼容性

- Better Auth 必须继续精确固定为 `1.6.23`。
- 现有已初始化数据库在迁移后直接处于 `completed`，普通注册和管理员创建用户继续工作。
- setup 成功响应和后续登录体验保持现有语义。
- `countUsers` 仍可用于统计，但不再作为初始化授权判断。
- 本迁移不得删除现有表、列、用户或账户。
- 历史异常数据库不会被自动重新开放；需要运维确认后单独修复。

## 14. 测试要求

### 14.1 迁移和约束

1. 空数据库迁移为 `open`。
2. 已有用户数据库迁移为 `completed`。
3. 单例和状态组合约束有效。
4. 迁移不包含 `DROP TABLE` 或 `DROP COLUMN`。
5. credential 触发器仅完成正确认领用户的初始化。

### 14.2 认领与并发

1. 两个并发 setup 请求最多一个取得 claim。
2. 最终只存在一个 user 和一个 credential account。
3. 唯一用户从插入时起就是管理员和超级管理员。
4. 并发失败请求返回 `SETUP_IN_PROGRESS` 或在胜者已经完成时返回 `SETUP_DONE`。
5. clear claim token 不进入数据库和响应。

### 14.3 创建门禁

1. `open` 状态下普通邮箱注册不能创建用户。
2. `claimed` 状态下其他邮箱注册不能创建用户。
3. OAuth 新用户 callback 在初始化未完成时不能创建用户。
4. 无 setup 上下文不能伪造首个管理员。
5. setup 上下文与 OAuth intent 同时出现时失败关闭。
6. `completed` 后现有邮箱、OAuth 和管理员创建用户路径正常。

### 14.4 失败恢复

1. 输入校验失败不创建 claim。
2. 用户插入前失败立即释放 claim。
3. 用户插入后、credential 前失败删除孤儿并释放。
4. 隔离期内其他请求不能抢占。
5. 超时且无 credential 时恢复 `open`。
6. 超时但 credential 已存在时协调为 `completed`。
7. credential 插入和超时清理并发后只出现两个合法终态之一。
8. 重复清理和协调保持幂等。

### 14.5 隐私和回归

1. 日志不含邮箱、密码、token、哈希或原始异常。
2. 客户端不收到内部异常消息。
3. setup 代码不再通过用户排序决定管理员。
4. Better Auth 版本仍为 `1.6.23`。
5. 完整测试、TypeScript 检查和 Wrangler dry-run 全部通过。

## 15. 验收标准

整改项 2 只有在以下条件全部满足后才算完成：

- D1 原子认领证明并发最多一个胜者；
- 所有用户创建入口在初始化未完成时由 Hook 统一关闭；
- 首用户插入即为超级管理员；
- credential 触发器完成初始化；
- 拥有者失败清理和超时恢复均有真实 D1 测试；
- 清理与 credential 插入竞态有确定性不变量测试；
- 普通注册在初始化完成后无回归；
- 隐私扫描通过；
- Better Auth 固定为 `1.6.23`；
- 完整测试、类型检查和部署 dry-run 通过。