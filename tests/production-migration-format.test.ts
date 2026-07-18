import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('production migration execution', () => {
  it('keeps triggers out of remote migration batches', async () => {
    const migrations = (await readdir('migrations'))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    const contents = await Promise.all(
      migrations.map((name) => readFile(`migrations/${name}`, 'utf8'))
    )

    expect(contents.join('\n')).not.toMatch(/\bCREATE\s+TRIGGER\b/i)
  })

  it('stores every remote trigger as one idempotent SQL command', async () => {
    const files = (await readdir('migrations/triggers')).sort()
    expect(files).toHaveLength(7)

    for (const file of files) {
      const sql = (await readFile(`migrations/triggers/${file}`, 'utf8')).trim()
      expect(sql).toMatch(/^CREATE TRIGGER IF NOT EXISTS\b/)
      expect(sql).toMatch(/\bBEGIN\b.*\bEND;$/)
      expect(sql).not.toMatch(/[\r\n]/)
      expect(sql).not.toMatch(/SELECT\s+CASE\b/i)
    }
  })

  it('uses the lockfile-pinned Wrangler for remote migrations', async () => {
    const workflow = await readFile('.github/workflows/deploy.yml', 'utf8')

    expect(workflow).toContain(
      'pnpm exec wrangler d1 migrations apply mc-server-hide-port-tool-db --remote'
    )
    expect(workflow).not.toContain(
      'npx wrangler d1 migrations apply mc-server-hide-port-tool-db --remote'
    )
    expect(workflow).toContain('name: Apply remote D1 migrations')
    expect(workflow).toContain('name: Install remote D1 triggers')
    expect(workflow).toContain('node scripts/install-d1-triggers.cjs --remote')
    expect(workflow).not.toContain('preCommands:')
  })

  it('uses the Node 24 Wrangler Action release', async () => {
    const workflow = await readFile('.github/workflows/deploy.yml', 'utf8')

    expect(workflow).toContain(
      'cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0 # v4'
    )
  })
})
