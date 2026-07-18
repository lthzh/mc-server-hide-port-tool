import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('frontend static hardening', () => {
  it('self-hosts the WebAuthn browser module under the self-only CSP', async () => {
    const [authSource, settingsSource, vendorSource, vendorLicense] = await Promise.all([
      readFile('public/static/pages-auth.js', 'utf8'),
      readFile('public/static/pages-settings.js', 'utf8'),
      readFile('public/static/vendor/simplewebauthn-browser.js', 'utf8'),
      readFile('public/static/vendor/simplewebauthn-browser.LICENSE.md', 'utf8')
    ])

    expect(authSource).toContain("from './vendor/simplewebauthn-browser.js'")
    expect(settingsSource).toContain("from './vendor/simplewebauthn-browser.js'")
    expect(authSource).not.toMatch(/import\s+.+\s+from\s+['"]https:\/\//)
    expect(settingsSource).not.toMatch(/import\s+.+\s+from\s+['"]https:\/\//)
    expect(vendorSource).toContain('[@simplewebauthn/browser@13.3.0]')
    expect(vendorSource).toContain('const exports = undefined')
    expect(vendorSource).toContain('export const startAuthentication')
    expect(vendorSource).toContain('export const startRegistration')
    expect(vendorLicense).toContain('MIT License')
  })

  it('assigns stored mail settings through DOM properties instead of HTML interpolation', async () => {
    const source = await readFile('public/static/admin-mail.js', 'utf8')
    const markup = source.slice(
      source.indexOf('card.innerHTML ='),
      source.indexOf('var removeButton')
    )

    expect(source).toContain("fromInput.value = String(row.from || '')")
    expect(source).toContain("keyInput.value = String(row.key || '')")
    expect(markup).not.toContain('row.from')
    expect(markup).not.toContain('row.key')
  })
})
