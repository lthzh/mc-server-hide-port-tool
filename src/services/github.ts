export type GitHubUser = {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  created_at: string
}

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
