export type DnsRecordRow = {
  id: string
  user_id: string | null
  root_domain: string
  subdomain: string
  host_name: string
  server_address: string
  port: number
  target_type: string
  target_record_id: string
  srv_record_id: string | null
  created_at: number
}

export function genId(): string {
  return crypto.randomUUID()
}

export async function listRecordsByUser(db: D1Database, userId: string): Promise<DnsRecordRow[]> {
  const result = await db
    .prepare('SELECT * FROM dns_record WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<DnsRecordRow>()
  return result.results ?? []
}

export async function listAllRecords(db: D1Database): Promise<DnsRecordRow[]> {
  const result = await db
    .prepare('SELECT * FROM dns_record ORDER BY created_at DESC')
    .all<DnsRecordRow>()
  return result.results ?? []
}

export async function findRecordById(db: D1Database, id: string): Promise<DnsRecordRow | null> {
  return await db.prepare('SELECT * FROM dns_record WHERE id = ?').bind(id).first<DnsRecordRow>()
}

export async function findRecordByHostName(
  db: D1Database,
  hostName: string
): Promise<DnsRecordRow | null> {
  return await db
    .prepare('SELECT * FROM dns_record WHERE host_name = ?')
    .bind(hostName)
    .first<DnsRecordRow>()
}

export async function insertRecord(
  db: D1Database,
  record: Omit<DnsRecordRow, 'id' | 'created_at'> & { id?: string }
): Promise<DnsRecordRow> {
  const id = record.id ?? genId()
  const created_at = Date.now()
  await db
    .prepare(
      `INSERT INTO dns_record
        (id, user_id, root_domain, subdomain, host_name, server_address, port, target_type, target_record_id, srv_record_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      record.user_id,
      record.root_domain,
      record.subdomain,
      record.host_name,
      record.server_address,
      record.port,
      record.target_type,
      record.target_record_id,
      record.srv_record_id,
      created_at
    )
    .run()

  return { ...record, id, created_at }
}

export async function deleteRecordRow(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM dns_record WHERE id = ?').bind(id).run()
}

export async function countUsers(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) as n FROM user').first<{ n: number }>()
  return r?.n ?? 0
}

export async function listAllUsers(db: D1Database): Promise<UserListRow[]> {
  const r = await db
    .prepare('SELECT id, name, email, emailVerified, role, super_admin, record_limit, createdAt FROM user ORDER BY "createdAt" ASC')
    .all<UserListRow>()
  return r.results ?? []
}

export type UserListRow = {
  id: string
  name: string
  email: string
  emailVerified: number
  role: string
  super_admin: number
  record_limit: number | null
  createdAt: number
}

export async function findUserById(db: D1Database, id: string) {
  return await db
    .prepare('SELECT id, name, email, role, super_admin, record_limit FROM user WHERE id = ?')
    .bind(id)
    .first<{ id: string; name: string; email: string; role: string; super_admin: number; record_limit: number | null }>()
}

export async function setUserRole(
  db: D1Database,
  id: string,
  role: 'admin' | 'user'
): Promise<void> {
  await db.prepare('UPDATE user SET role = ? WHERE id = ?').bind(role, id).run()
}

export async function setUserRecordLimit(
  db: D1Database,
  id: string,
  limit: number | null
): Promise<void> {
  const value = limit === null ? null : Math.max(0, Math.floor(limit))
  await db
    .prepare('UPDATE user SET record_limit = ? WHERE id = ?')
    .bind(value, id)
    .run()
}

export async function setSuperAdmin(
  db: D1Database,
  id: string,
  superAdmin: boolean
): Promise<void> {
  await db
    .prepare('UPDATE user SET super_admin = ? WHERE id = ?')
    .bind(superAdmin ? 1 : 0, id)
    .run()
}

export async function isSuperAdmin(db: D1Database, id: string): Promise<boolean> {
  const r = await db
    .prepare('SELECT super_admin FROM user WHERE id = ?')
    .bind(id)
    .first<{ super_admin: number }>()
  return !!r?.super_admin
}

export async function countRecordsByUser(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) as n FROM dns_record WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>()
  return r?.n ?? 0
}

/**
 * 计算用户的最终记录上限：用户自定义优先，否则用全局上限。
 */
export function resolveRecordLimit(
  userLimit: number | null | undefined,
  globalLimit: number
): number {
  if (userLimit === null || userLimit === undefined) return globalLimit
  return Math.max(0, Math.floor(userLimit))
}

type DnsLimitUser = {
  role?: string | null
  super_admin?: number | null
  record_limit?: number | null
}

export function hasUnlimitedDnsLimits(user: DnsLimitUser | null | undefined): boolean {
  return user?.role === 'admin' || Number(user?.super_admin ?? 0) > 0
}

export function resolveUserRecordLimit(
  user: DnsLimitUser | null | undefined,
  globalLimit: number
): number {
  if (hasUnlimitedDnsLimits(user)) return 0
  return resolveRecordLimit(user?.record_limit ?? null, globalLimit)
}

export function resolveMinSubdomainLength(
  user: DnsLimitUser | null | undefined,
  globalMinLength: number
): number {
  if (hasUnlimitedDnsLimits(user)) return 0
  return Math.max(0, Math.floor(globalMinLength))
}

export async function deleteUserCascade(db: D1Database, id: string): Promise<void> {
  const user = await db
    .prepare('SELECT email FROM user WHERE id = ?')
    .bind(id)
    .first<{ email: string }>()

  await db.prepare('DELETE FROM dns_record WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM session WHERE userId = ?').bind(id).run()
  await db.prepare('DELETE FROM account WHERE userId = ?').bind(id).run()
  // Keep invite history, but detach FK references that would block user deletion.
  await db.prepare('UPDATE invite_code SET used_by = NULL WHERE used_by = ?').bind(id).run()
  await db.prepare('DELETE FROM invite_code WHERE created_by = ? AND used_by IS NULL').bind(id).run()
  if (user?.email) {
    await db.prepare('DELETE FROM email_verification WHERE email = ?').bind(user.email).run()
  }
  await db.prepare('DELETE FROM user WHERE id = ?').bind(id).run()
}
