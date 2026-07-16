import type { DnsRecordRow } from './dns-records'
import { deleteRecordRow } from './dns-records'
import {
  logDnsExternalServiceFailure,
  type DnsExternalFailureEventInput,
  type DnsExternalFailureCode,
  type DnsExternalFailureStage
} from '../lib/external-service-security'

export type Bindings = CloudflareBindings & {
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
}

type CloudflareError = {
  message?: string
}

type CloudflareListResult<T> = {
  success: boolean
  result: T[]
  errors?: CloudflareError[]
}

type CloudflareSingleResult<T> = {
  success: boolean
  result: T
  errors?: CloudflareError[]
}

type CloudflareZone = {
  id: string
}

type CloudflareDnsRecord = {
  id: string
  type: string
  name: string
  content?: string
}

export class CloudflareDnsError extends Error {
  readonly code: DnsExternalFailureCode
  readonly stage: DnsExternalFailureStage
  readonly status?: number
  readonly retriable: boolean

  constructor(input: {
    code: DnsExternalFailureCode
    stage: DnsExternalFailureStage
    status?: number
    retriable?: boolean
  }) {
    super(input.code)
    this.name = 'CloudflareDnsError'
    this.code = input.code
    this.stage = input.stage
    this.status = input.status
    this.retriable = !!input.retriable
  }
}

export function isCloudflareDnsError(error: unknown): error is CloudflareDnsError {
  return error instanceof CloudflareDnsError
}

export function toDnsFailureEvent(
  error: unknown,
  fallbackStage: DnsExternalFailureStage
): DnsExternalFailureEventInput {
  if (isCloudflareDnsError(error)) {
    return {
      code: error.code,
      stage: error.stage,
      status: error.status,
      retriable: error.retriable
    }
  }
  return {
    code: 'DNS_EXTERNAL_FAILURE',
    stage: fallbackStage,
    retriable: false
  }
}

function isRetriableCloudflareStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

type DnsRecordBody =
  | {
      type: 'A' | 'AAAA' | 'CNAME'
      name: string
      content: string
      ttl: 1
      proxied: false
    }
  | {
      type: 'SRV'
      name: string
      ttl: 1
      data: {
        priority: number
        weight: number
        port: number
        target: string
      }
    }

export async function deleteRecordAndCloudflare(
  env: Bindings,
  record: DnsRecordRow
): Promise<void> {
  const token = getCloudflareApiToken(env, record.root_domain)
  if (!token) {
    logDnsExternalServiceFailure({ code: 'DNS_CONFIG_MISSING', stage: 'record_delete' })
    await deleteRecordRow(env.DB, record.id)
    return
  }

  try {
    const zoneId = await fetchZoneId(token, record.root_domain)
    await deleteCloudflareDnsRecord(token, zoneId, record.target_record_id).catch((error) => {
      logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
    })
    if (record.srv_record_id) {
      await deleteCloudflareDnsRecord(token, zoneId, record.srv_record_id).catch((error) => {
        logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
      })
    }
  } catch (error) {
    logDnsExternalServiceFailure(toDnsFailureEvent(error, 'record_delete'))
  }

  await deleteRecordRow(env.DB, record.id)
}

export async function deleteCloudflareDnsRecord(
  token: string,
  zoneId: string,
  recordId: string | null | undefined
): Promise<void> {
  if (!recordId) return
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`
  await sendCloudflareRequest(token, url, { method: 'DELETE' }, 'record_delete')
}

export async function cleanupCloudflareDnsRecords(
  token: string,
  zoneId: string,
  recordIds: Array<string | null | undefined>
): Promise<void> {
  const unique = [...new Set(recordIds.filter((id): id is string => !!id))]
  await Promise.all(unique.map((id) => deleteCloudflareDnsRecord(token, zoneId, id).catch((error) => {
    logDnsExternalServiceFailure(toDnsFailureEvent(error, 'cleanup'))
  })))
}



export function getCloudflareApiToken(env: Bindings, rootDomain: string): string | null {
  if (!rootDomain) return null
  const key = `${rootDomain.replace(/\./g, '_')}_CLOUDFLARE_API_TOKEN`
  const value = (env as unknown as Record<string, string | undefined>)[key]
  return value && value.trim() ? value.trim() : null
}

export function getAllowedDomains(env: Bindings): string[] {
  const raw = env.DOMAINS as unknown as string | string[] | undefined

  if (Array.isArray(raw)) {
    return uniqueDomains(raw)
  }

  if (!raw || !raw.trim()) {
    return []
  }

  const trimmed = raw.trim()

  try {
    const parsed = JSON.parse(trimmed)

    if (Array.isArray(parsed)) {
      return uniqueDomains(parsed)
    }

    if (typeof parsed === 'string') {
      return uniqueDomains([parsed])
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return uniqueDomains(trimmed.split(','))
}

function uniqueDomains(values: unknown[]): string[] {
  const seen = new Set<string>()
  const domains: string[] = []

  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }

    const domain = normalizeDomain(value)
    if (!domain || seen.has(domain)) {
      continue
    }

    seen.add(domain)
    domains.push(domain)
  }

  return domains
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
}

export function parseCreateDnsRequest(
  body: unknown,
  domains: string[]
):
  | {
      ok: true
      value: {
        subdomain: string
        rootDomain: string
        serverAddress: string
        port: number
        targetRecordType: 'A' | 'AAAA' | 'CNAME'
      }
    }
  | { ok: false; message: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: '请求体格式不正确' }
  }

  const data = body as Record<string, unknown>
  const subdomain = normalizeDomain(String(data.subdomain ?? ''))
  const rootDomain = normalizeDomain(String(data.rootDomain ?? ''))
  const rawServerAddress = String(data.serverAddress ?? data.ip ?? '').trim()
  const serverAddress = normalizeServerAddress(rawServerAddress)
  const port = parsePort(data.port)
  const targetRecordType = getTargetRecordType(serverAddress)

  if (!isValidSubdomain(subdomain)) {
    return { ok: false, message: '子域名格式不正确，只能使用普通域名标签，例如 play 或 mc.play' }
  }

  if (!domains.includes(rootDomain)) {
    return { ok: false, message: '根域名不在后端允许列表中' }
  }

  if (subdomain === rootDomain || subdomain.endsWith(`.${rootDomain}`)) {
    return { ok: false, message: '子域名只需要填写前缀部分，例如 play，不要填写完整根域名' }
  }

  if (!targetRecordType) {
    return { ok: false, message: '服务器地址必须是合法的 IPv4、IPv6 或域名' }
  }

  if (targetRecordType === 'CNAME' && serverAddress === `${subdomain}.${rootDomain}`) {
    return { ok: false, message: '目标域名不能和要创建的域名相同' }
  }

  if (!port) {
    return { ok: false, message: '端口必须是 1 到 65535 之间的整数' }
  }

  return {
    ok: true,
    value: {
      subdomain,
      rootDomain,
      serverAddress,
      port,
      targetRecordType
    }
  }
}

function parsePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number(String(value ?? '').trim())

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }

  return port
}

function normalizeServerAddress(value: string): string {
  return isIPv6(value) ? value : normalizeDomain(value)
}

function getTargetRecordType(value: string): 'A' | 'AAAA' | 'CNAME' | null {
  if (isIPv4(value)) {
    return 'A'
  }

  if (isIPv6(value)) {
    return 'AAAA'
  }

  if (isValidHostname(value)) {
    return 'CNAME'
  }

  return null
}

function isIPv4(ip: string): boolean {
  const parts = ip.split('.')

  if (parts.length !== 4) {
    return false
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function isIPv6(ip: string): boolean {
  if (!ip.includes(':')) {
    return false
  }

  try {
    new URL(`http://[${ip}]/`)
    return true
  } catch {
    return false
  }
}

function isValidSubdomain(value: string): boolean {
  if (!value || value.length > 253 || value.includes('..')) {
    return false
  }

  return value.split('.').every(isValidDomainLabel)
}

function isValidHostname(value: string): boolean {
  if (!value || value.length > 253 || value.includes('..')) {
    return false
  }

  return value.split('.').every(isValidDomainLabel)
}

function isValidDomainLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

export async function fetchZoneId(token: string, domain: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`
  const data = await sendCloudflareRequest<CloudflareListResult<CloudflareZone>>(token, url, {}, 'zone_lookup')

  if (data.success && data.result.length > 0) {
    return data.result[0].id
  }

  throw new CloudflareDnsError({ code: 'CLOUDFLARE_ZONE_NOT_FOUND', stage: 'zone_lookup' })
}

export async function findOccupiedRecords(
  token: string,
  zoneId: string,
  names: string[]
): Promise<CloudflareDnsRecord[]> {
  const recordLists = await Promise.all(names.map((name) => findDnsRecordsByName(token, zoneId, name)))
  return recordLists.flat()
}

async function findDnsRecordsByName(
  token: string,
  zoneId: string,
  name: string
): Promise<CloudflareDnsRecord[]> {
  const params = new URLSearchParams({
    'name.exact': name,
    match: 'all',
    per_page: '100'
  })
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${params}`
  const data = await sendCloudflareRequest<CloudflareListResult<CloudflareDnsRecord>>(token, url, {}, 'record_lookup')

  if (!data.success) {
    throw new CloudflareDnsError({ code: 'DNS_EXTERNAL_FAILURE', stage: 'record_lookup' })
  }

  return data.result
}


export async function updateDnsRecord(
  token: string,
  zoneId: string,
  recordId: string,
  body: DnsRecordBody
): Promise<CloudflareDnsRecord> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`
  const data = await sendCloudflareRequest<CloudflareSingleResult<CloudflareDnsRecord>>(token, url, {
    method: 'PUT',
    body: JSON.stringify(body)
  }, 'record_update')

  if (!data.success) {
    throw new CloudflareDnsError({ code: 'DNS_EXTERNAL_FAILURE', stage: 'record_update' })
  }

  return data.result
}

export function parseUpdateDnsRequest(
  body: unknown
):
  | {
      ok: true
      value: {
        serverAddress: string
        port: number
        targetRecordType: 'A' | 'AAAA' | 'CNAME'
      }
    }
  | { ok: false; message: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: '请求体格式不正确' }
  }

  const data = body as Record<string, unknown>
  const rawServerAddress = String(data.serverAddress ?? data.ip ?? '').trim()
  const serverAddress = normalizeServerAddress(rawServerAddress)
  const port = parsePort(data.port)
  const targetRecordType = getTargetRecordType(serverAddress)

  if (!targetRecordType) {
    return { ok: false, message: '服务器地址必须是合法的 IPv4、IPv6 或域名' }
  }

  if (!port) {
    return { ok: false, message: '端口必须是 1 到 65535 之间的整数' }
  }

  return {
    ok: true,
    value: {
      serverAddress,
      port,
      targetRecordType
    }
  }
}

export async function createDnsRecord(
  token: string,
  zoneId: string,
  body: DnsRecordBody
): Promise<CloudflareDnsRecord> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`
  const data = await sendCloudflareRequest<CloudflareSingleResult<CloudflareDnsRecord>>(token, url, {
    method: 'POST',
    body: JSON.stringify(body)
  }, 'record_create')

  if (!data.success) {
    throw new CloudflareDnsError({ code: 'DNS_EXTERNAL_FAILURE', stage: 'record_create' })
  }

  return data.result
}

async function sendCloudflareRequest<T>(
  token: string,
  url: string,
  init: RequestInit = {},
  stage: DnsExternalFailureStage
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    ...init,
    headers
  })
  const text = await response.text()
  const data = parseJsonResponse<T>(text)

  if (!response.ok) {
    throw new CloudflareDnsError({
      code: 'CLOUDFLARE_REQUEST_FAILED',
      stage,
      status: response.status,
      retriable: isRetriableCloudflareStatus(response.status)
    })
  }

  return data
}

function parseJsonResponse<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function isCloudflareErrorResponse(value: unknown): value is { errors?: CloudflareError[] } {
  return Boolean(value && typeof value === 'object' && 'errors' in value)
}

function getCloudflareErrorMessage(errors: CloudflareError[] | undefined): string {
  return errors?.map((error) => error.message).filter(Boolean).join('; ') || 'Cloudflare 返回未知错误'
}
