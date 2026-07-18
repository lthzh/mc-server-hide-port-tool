const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { dirname, resolve } = require('node:path')

const packageEntry = require.resolve('@simplewebauthn/browser')
const sourcePath = resolve(dirname(packageEntry), '../dist/bundle/index.umd.min.js')
const licensePath = resolve(dirname(packageEntry), '../LICENSE.md')
const outputPath = resolve(
  process.cwd(),
  'public/static/vendor/simplewebauthn-browser.js'
)
const outputLicensePath = resolve(
  process.cwd(),
  'public/static/vendor/simplewebauthn-browser.LICENSE.md'
)

async function main() {
  const [source, license] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(licensePath, 'utf8')
  ])
  const moduleSource = `const exports = undefined;
const module = undefined;
const define = undefined;
${source.trim()}
export const startAuthentication = globalThis.SimpleWebAuthnBrowser.startAuthentication;
export const startRegistration = globalThis.SimpleWebAuthnBrowser.startRegistration;
`

  await mkdir(dirname(outputPath), { recursive: true })
  await Promise.all([
    writeFile(outputPath, moduleSource, 'utf8'),
    writeFile(outputLicensePath, license, 'utf8')
  ])
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
