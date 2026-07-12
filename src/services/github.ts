export type GitHubUser = {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  created_at: string
}

/** Stable machine code embedded in thrown errors for callback interception. */
export const GITHUB_ACCOUNT_AGE_REJECTED_CODE = 'GITHUB_ACCOUNT_AGE_REJECTED'

export async function getGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hide-port-tool'
    }
  })
  if (!res.ok) return null
  return (await res.json()) as GitHubUser
}

export async function getGitHubPrimaryEmail(accessToken: string): Promise<string | null> {
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hide-port-tool'
    }
  })
  if (!emailsRes.ok) return null
  const emails = (await emailsRes.json()) as Array<{
    email?: string
    primary?: boolean
    verified?: boolean
  }>
  const primary = emails.find((e) => e.primary && e.email) || emails.find((e) => e.email)
  return primary?.email ?? null
}

export function meetsAgeRequirement(createdAt: string, minDays: number): boolean {
  if (!minDays || minDays <= 0) return true
  const createdMs = Date.parse(createdAt)
  if (Number.isNaN(createdMs)) return false
  const ageDays = (Date.now() - createdMs) / 86400000
  return ageDays >= minDays
}

export function githubAgeErrorMessage(minDays: number): string {
  return `GitHub 账号注册天数不足 ${minDays} 天`
}

export function throwGitHubAgeRejected(minDays: number): never {
  // Include both a stable code (for interceptors) and human text.
  throw new Error(`${GITHUB_ACCOUNT_AGE_REJECTED_CODE}:${minDays} ${githubAgeErrorMessage(minDays)}`)
}

export function isGitHubAgeRejectedError(text: string | null | undefined): boolean {
  return !!text && text.includes(GITHUB_ACCOUNT_AGE_REJECTED_CODE)
}

export function parseGitHubAgeRejectedMinDays(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/GITHUB_ACCOUNT_AGE_REJECTED:(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function githubAgeRejectedPath(minDays: number): string {
  return `/register/github-age-rejected?min_days=${encodeURIComponent(String(Math.max(0, minDays)))}`
}
