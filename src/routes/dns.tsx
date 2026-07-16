import type { Hono } from 'hono'
import { getCurrentSession } from '../auth'
import { getSettings } from '../services/settings'
import {
  countRecordsByUser,
  findRecordByHostName,
  findRecordById,
  findUserById,
  insertRecord,
  resolveMinSubdomainLength,
  resolveUserRecordLimit,
  updateRecordTarget
} from '../services/dns-records'
import {
  cleanupCloudflareDnsRecords,
  createDnsRecord,
  deleteCloudflareDnsRecord,
  deleteRecordAndCloudflare,
  fetchZoneId,
  findOccupiedRecords,
  getAllowedDomains,
  getCloudflareApiToken,
  parseCreateDnsRequest,
  parseUpdateDnsRequest,
  toDnsFailureEvent,
  updateDnsRecord,
  type Bindings
} from '../services/cloudflare-dns'
import { isSameOriginMutation, verifyCsrfToken } from '../lib/security'
import {
  DNS_CONFIG_SAFE_MESSAGE,
  DNS_GENERIC_SAFE_MESSAGE,
  logDnsExternalServiceFailure,
  safeDnsClientMessage
} from '../lib/external-service-security'


async function requireDnsMutationAuth(c: any): Promise<Response | null> {
  if (!isSameOriginMutation(c.req.raw)) {
    return c.json({ success: false, message: 'Forbidden: invalid origin' }, 403)
  }
  const csrfHeader = c.req.header('x-csrf-token') || ''
  // Cookie-authenticated JSON mutations must include CSRF header matching cookie.
  if (!verifyCsrfToken(c.req.header('Cookie'), csrfHeader)) {
    return c.json({ success: false, message: 'Forbidden: invalid CSRF token' }, 403)
  }
  return null
}

function dnsExternalErrorResponse(
  c: any,
  error: unknown,
  fallbackStage: Parameters<typeof toDnsFailureEvent>[1]
): Response {
  const event = toDnsFailureEvent(error, fallbackStage)
  logDnsExternalServiceFailure(event)
  return c.json({ success: false, message: safeDnsClientMessage(event.code) }, 500)
}

export function registerDnsRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/api/domains', async (c) => {
    const domains = getAllowedDomains(c.env)
    const settings = await getSettings(c.env.DB)
    const session = await getCurrentSession(c.env, c.req.raw.headers)
    let recordLimit: number | null = null
    let minSubdomainLength = Math.max(0, settings.min_subdomain_length)
    let recordCount = 0
    if (session) {
      const userRow = await findUserById(c.env.DB, session.user.id)
      recordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
      minSubdomainLength = resolveMinSubdomainLength(userRow, settings.min_subdomain_length)
      recordCount = await countRecordsByUser(c.env.DB, session.user.id)
    }
    return c.json({
      success: true,
      domains,
      min_subdomain_length: minSubdomainLength,
      record_limit: recordLimit,
      record_count: recordCount,
      max_records_per_user: settings.max_records_per_user
    })
  })

  app.post('/api/create-dns', async (c) => {
    try {
      const session = await getCurrentSession(c.env, c.req.raw.headers)
      if (!session) {
        return c.json({ success: false, message: '未登录，请先登录' }, 401)
      }
      const csrfDenied = await requireDnsMutationAuth(c)
      if (csrfDenied) return csrfDenied
      const userId = session.user.id
      const userRow = await findUserById(c.env.DB, userId)

      const body = await c.req.json()
      const domains = getAllowedDomains(c.env)

      if (domains.length === 0) {
        logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'config' })
        return c.json({ success: false, message: DNS_CONFIG_SAFE_MESSAGE }, 500)
      }

      const request = parseCreateDnsRequest(body, domains)
      if (!request.ok) {
        return c.json({ success: false, message: request.message }, 400)
      }

      const { subdomain, rootDomain, serverAddress, port, targetRecordType } = request.value
      const token = getCloudflareApiToken(c.env, rootDomain)
      if (!token) {
        logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'config' })
        return c.json({ success: false, message: DNS_CONFIG_SAFE_MESSAGE }, 500)
      }

      const settings = await getSettings(c.env.DB)
      const minLen = resolveMinSubdomainLength(userRow, settings.min_subdomain_length)
      const subdomainInput = String((body as Record<string, unknown>).subdomain ?? '').trim()
      if (minLen > 0 && subdomainInput.length < minLen) {
        return c.json(
          {
            success: false,
            message: '子域名长度不能少于 ' + minLen + ' 个字符'
          },
          400
        )
      }

      const userRecordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
      if (userRecordLimit > 0) {
        const currentCount = await countRecordsByUser(c.env.DB, userId)
        if (currentCount >= userRecordLimit) {
          return c.json(
            {
              success: false,
              message: '已达记录数量上限（' + userRecordLimit + ' 条），无法继续创建'
            },
            403
          )
        }
      }

      const hostName = subdomain + '.' + rootDomain
      const srvName = '_minecraft._tcp.' + hostName

      const existing = await findRecordByHostName(c.env.DB, hostName)
      if (existing) {
        return c.json(
          {
            success: false,
            code: 'record_occupied',
            message: '域名 ' + hostName + ' 已被占用，请换一个子域名'
          },
          409
        )
      }

      const zoneId = await fetchZoneId(token, rootDomain)
      const occupiedRecords = await findOccupiedRecords(token, zoneId, [hostName, srvName])
      if (occupiedRecords.length > 0) {
        return c.json(
          {
            success: false,
            code: 'record_occupied',
            message: '域名 ' + hostName + ' 已被占用，请换一个子域名'
          },
          409
        )
      }

      let targetRecordId: string | null = null
      let srvRecordId: string | null = null
      try {
        const targetRecord = await createDnsRecord(token, zoneId, {
          type: targetRecordType,
          name: hostName,
          content: serverAddress,
          ttl: 1,
          proxied: false
        })
        targetRecordId = targetRecord.id

        const srvRecord = await createDnsRecord(token, zoneId, {
          type: 'SRV',
          name: srvName,
          ttl: 1,
          data: { priority: 0, weight: 5, port, target: hostName }
        })
        srvRecordId = srvRecord.id

        const row = await insertRecord(c.env.DB, {
          user_id: userId,
          root_domain: rootDomain,
          subdomain,
          host_name: hostName,
          server_address: serverAddress,
          port,
          target_type: targetRecordType,
          target_record_id: targetRecord.id,
          srv_record_id: srvRecord.id
        })

        // Re-check after insert so concurrent creates cannot exceed the user limit.
        const currentCount = await countRecordsByUser(c.env.DB, userId)
        if (userRecordLimit > 0 && currentCount > userRecordLimit) {
          await deleteRecordAndCloudflare(c.env, row)
          return c.json(
            {
              success: false,
              message: '已达记录数量上限（' + userRecordLimit + ' 条），无法继续创建'
            },
            403
          )
        }

        return c.json({
          success: true,
          message:
            'DNS 记录已创建：' +
            hostName +
            ' -> ' +
            serverAddress +
            '，Minecraft Java 端口 ' +
            port,
          record: row,
          record_count: currentCount,
          record_limit: userRecordLimit,
          records: { target: targetRecord, srv: srvRecord }
        })
      } catch (err) {
        // Roll back any Cloudflare records created before DB insert / later step failed.
        await cleanupCloudflareDnsRecords(token, zoneId, [targetRecordId, srvRecordId])
        throw err
      }
    } catch (err) {
      return dnsExternalErrorResponse(c, err, 'record_create')
    }
  })

  app.post('/api/dns/:id/delete', async (c) => {
    try {
      const session = await getCurrentSession(c.env, c.req.raw.headers)
      if (!session) {
        return c.json({ success: false, message: '未登录，请先登录' }, 401)
      }
      const csrfDenied = await requireDnsMutationAuth(c)
      if (csrfDenied) return csrfDenied
      const id = c.req.param('id')
      const record = await findRecordById(c.env.DB, id)
      if (!record) {
        return c.json({ success: false, message: '记录不存在' }, 404)
      }
      if (record.user_id !== session.user.id) {
        return c.json({ success: false, message: '无权删除该记录' }, 403)
      }
      await deleteRecordAndCloudflare(c.env, record)
      const currentCount = await countRecordsByUser(c.env.DB, session.user.id)
      const settings = await getSettings(c.env.DB)
      const userRow = await findUserById(c.env.DB, session.user.id)
      const recordLimit = resolveUserRecordLimit(userRow, settings.max_records_per_user)
      return c.json({
        success: true,
        message: '记录已删除',
        id,
        record_count: currentCount,
        record_limit: recordLimit
      })
    } catch (err) {
      logDnsExternalServiceFailure(toDnsFailureEvent(err, 'record_delete'))
      return c.json({ success: false, message: DNS_GENERIC_SAFE_MESSAGE }, 500)
    }
  })

  app.post('/api/dns/:id/update', async (c) => {
    try {
      const session = await getCurrentSession(c.env, c.req.raw.headers)
      if (!session) {
        return c.json({ success: false, message: '未登录，请先登录' }, 401)
      }
      const csrfDenied = await requireDnsMutationAuth(c)
      if (csrfDenied) return csrfDenied

      const id = c.req.param('id')
      const record = await findRecordById(c.env.DB, id)
      if (!record) {
        return c.json({ success: false, message: '记录不存在' }, 404)
      }
      if (record.user_id !== session.user.id) {
        return c.json({ success: false, message: '无权修改该记录' }, 403)
      }

      const body = await c.req.json()
      const request = parseUpdateDnsRequest(body)
      if (!request.ok) {
        return c.json({ success: false, message: request.message }, 400)
      }

      const { serverAddress, port, targetRecordType } = request.value
      if (targetRecordType === 'CNAME' && serverAddress === record.host_name) {
        return c.json({ success: false, message: '目标域名不能和要创建的域名相同' }, 400)
      }

      if (
        record.server_address === serverAddress &&
        Number(record.port) === port &&
        record.target_type === targetRecordType
      ) {
        return c.json({
          success: true,
          message: '记录未变化',
          record
        })
      }

      const token = getCloudflareApiToken(c.env, record.root_domain)
      if (!token) {
        logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'config' })
        return c.json({ success: false, message: DNS_CONFIG_SAFE_MESSAGE }, 500)
      }

      const zoneId = await fetchZoneId(token, record.root_domain)
      const hostName = record.host_name
      const srvName = '_minecraft._tcp.' + hostName

      let targetRecordId = record.target_record_id
      let srvRecordId = record.srv_record_id
      let createdTargetId: string | null = null
      let createdSrvId: string | null = null

      try {
        if (record.target_type === targetRecordType) {
          await updateDnsRecord(token, zoneId, record.target_record_id, {
            type: targetRecordType,
            name: hostName,
            content: serverAddress,
            ttl: 1,
            proxied: false
          })
        } else {
          // Cloudflare does not allow A/AAAA/CNAME to coexist on the same name.
          // Delete the old target first, then create the new type.
          await deleteCloudflareDnsRecord(token, zoneId, record.target_record_id)
          const created = await createDnsRecord(token, zoneId, {
            type: targetRecordType,
            name: hostName,
            content: serverAddress,
            ttl: 1,
            proxied: false
          })
          createdTargetId = created.id
          targetRecordId = created.id
        }

        if (srvRecordId) {
          await updateDnsRecord(token, zoneId, srvRecordId, {
            type: 'SRV',
            name: srvName,
            ttl: 1,
            data: { priority: 0, weight: 5, port, target: hostName }
          })
        } else {
          const srvRecord = await createDnsRecord(token, zoneId, {
            type: 'SRV',
            name: srvName,
            ttl: 1,
            data: { priority: 0, weight: 5, port, target: hostName }
          })
          createdSrvId = srvRecord.id
          srvRecordId = srvRecord.id
        }

        const updated = await updateRecordTarget(c.env.DB, record.id, {
          server_address: serverAddress,
          port,
          target_type: targetRecordType,
          target_record_id: targetRecordId,
          srv_record_id: srvRecordId
        })

        return c.json({
          success: true,
          message: 'DNS 记录已更新：' + hostName + ' -> ' + serverAddress + '，端口 ' + port,
          record: updated
        })
      } catch (err) {
        // Best-effort cleanup for records created during this update attempt.
        await cleanupCloudflareDnsRecords(token, zoneId, [createdTargetId, createdSrvId])
        throw err
      }
    } catch (err) {
      return dnsExternalErrorResponse(c, err, 'record_update')
    }
  })
}
