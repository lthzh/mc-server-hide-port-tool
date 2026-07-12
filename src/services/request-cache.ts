type CacheEntry<T> = {
  expiresAt: number
  value: Promise<T>
}

const DEFAULT_TTL_MS = 5_000

const settingsCache = new WeakMap<D1Database, CacheEntry<unknown>>()
const oauthEnabledCache = new WeakMap<D1Database, CacheEntry<unknown>>()

function readCache<T>(map: WeakMap<D1Database, CacheEntry<unknown>>, db: D1Database): Promise<T> | null {
  const hit = map.get(db)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    map.delete(db)
    return null
  }
  return hit.value as Promise<T>
}

function writeCache<T>(
  map: WeakMap<D1Database, CacheEntry<unknown>>,
  db: D1Database,
  value: Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<T> {
  map.set(db, {
    expiresAt: Date.now() + ttlMs,
    value
  })
  // Avoid sticky rejected promises in cache
  value.catch(() => {
    const cur = map.get(db)
    if (cur?.value === value) map.delete(db)
  })
  return value
}

export function getCachedSettings<T>(
  db: D1Database,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<T> {
  const hit = readCache<T>(settingsCache, db)
  if (hit) return hit
  return writeCache(settingsCache, db, loader(), ttlMs)
}

export function invalidateSettingsCache(db?: D1Database): void {
  if (db) settingsCache.delete(db)
}

export function getCachedEnabledOAuthProviders<T>(
  db: D1Database,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<T> {
  const hit = readCache<T>(oauthEnabledCache, db)
  if (hit) return hit
  return writeCache(oauthEnabledCache, db, loader(), ttlMs)
}

export function invalidateOAuthProviderCache(db?: D1Database): void {
  if (db) oauthEnabledCache.delete(db)
}
