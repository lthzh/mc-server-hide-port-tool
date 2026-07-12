import { betterAuth } from 'better-auth'
import { genericOAuth } from 'better-auth/plugins'
import {
  listEnabledOAuthProviders,
  toGenericOAuthConfig,
  type OAuthProviderRow
} from './services/oauth-providers'

export type AuthBindings = {
  DB: D1Database
  BETTER_AUTH_SECRET?: string
  APP_NAME?: string
  BETTER_AUTH_URL?: string
}

export type Auth = ReturnType<typeof betterAuth>

export async function createAuth(
  env: AuthBindings,
  oauthProviders?: OAuthProviderRow[]
) {
  const providers =
    oauthProviders ?? (await listEnabledOAuthProviders(env.DB).catch(() => [] as OAuthProviderRow[]))

  const genericConfigs = providers.map((p) => toGenericOAuthConfig(p, env.DB))

  return betterAuth({
    appName: env.APP_NAME || 'hide-port-tool',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true
    },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'user',
          input: false
        },
        super_admin: {
          type: 'number',
          required: false,
          defaultValue: 0,
          input: false
        },
        record_limit: {
          type: 'number',
          required: false,
          defaultValue: null,
          input: false
        }
      }
    },
    plugins:
      genericConfigs.length > 0
        ? [
            genericOAuth({
              config: genericConfigs
            })
          ]
        : []
  })
}

export type AuthUser = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image?: string | null | undefined
  role?: string | null | undefined
  super_admin?: number | null | undefined
  record_limit?: number | null | undefined
  createdAt: Date
  updatedAt: Date
}

export type AuthSession = {
  session: { id: string; userId: string; expiresAt: Date; token: string }
  user: AuthUser
}

export async function getCurrentSession(env: AuthBindings, headers: Headers): Promise<AuthSession | null> {
  const auth = await createAuth(env)
  return await auth.api.getSession({ headers })
}

export async function getCurrentUser(env: AuthBindings, headers: Headers): Promise<AuthUser | null> {
  const s = await getCurrentSession(env, headers)
  if (!s) return null
  const u = s.user as any
  return {
    ...s.user,
    role: (u.role as string | undefined) ?? 'user',
    super_admin: (u.super_admin as number | null | undefined) ?? 0,
    record_limit: u.record_limit === undefined || u.record_limit === null ? null : Number(u.record_limit)
  }
}

export function isSuperAdminUser(u: AuthUser | null | undefined): boolean {
  return !!u && Number(u.super_admin ?? 0) > 0
}

export async function isAdmin(env: AuthBindings, headers: Headers): Promise<boolean> {
  const user = await getCurrentUser(env, headers)
  return !!user && user.role === 'admin'
}

export async function requireAdmin(env: AuthBindings, headers: Headers): Promise<AuthUser | null> {
  const user = await getCurrentUser(env, headers)
  if (!user || user.role !== 'admin') return null
  return user
}
