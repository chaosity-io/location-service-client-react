// Proves the PUBLISHED package layout actually loads (#16).
//
// 0.4.0 shipped an ESM entry point that threw ERR_MODULE_NOT_FOUND on every
// `import` outside a bundler: tsc emitted extensionless relative specifiers,
// which Node's ESM resolver rejects. Every test passed and the build was green,
// because vitest and every consumer we had were bundlers — the one thing nothing
// exercised was Node resolving dist/ itself. It also took @chaosity/address-form
// down with it, since that package imports this one.
//
// So this loads the entry point through BOTH module systems, the way a consumer
// would. It runs against dist/, so it must come after `npm run build`.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/** Everything below is addressed from the package root, not scripts/. */
const root = new URL('../', import.meta.url)
const failures = []

/** Print and exit non-zero if anything has gone wrong; otherwise fall through. */
function report() {
  if (!failures.length) return
  console.error('\npackage smoke FAILED:')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

// The whole public surface, per AGENTS.md. There is deliberately one entry
// point: a subpath would be a packaging decision, not a refactor.
const EXPECTED = [
  'LocationClientProvider',
  'useLocationClient',
  'useMapLanguage',
]
const paths = { import: 'dist/index.js', require: 'dist/cjs/index.js' }

for (const [kind, file] of Object.entries(paths)) {
  const url = new URL(file, root)
  if (!existsSync(url)) {
    failures.push(`${kind}: ${file} was never emitted`)
    continue
  }
  try {
    const mod =
      kind === 'import' ? await import(url.href) : require(fileURLToPath(url))
    const missing = EXPECTED.filter((name) => !(name in mod))
    if (missing.length) {
      failures.push(`${kind}: loaded but missing ${missing.join(', ')}`)
    } else {
      console.log(`  ok  ${kind} — ${Object.keys(mod).length} exports`)
    }
  } catch (error) {
    failures.push(
      `${kind}: ${error.code ?? error.name} — ${error.message.split('\n')[0]}`,
    )
  }
}

// Everything past this point dereferences the modules, so a load failure has to
// stop here — otherwise a broken build reports an unhandled stack trace instead
// of the diagnosis above.
if (failures.length) report()

// The two halves of a dual package must expose the SAME public surface. An
// export present in one and missing from the other is invisible above (both
// still load) and breaks exactly half the consumers. `__esModule` is
// TypeScript's interop marker, not public API.
const esm = Object.keys(await import(new URL(paths.import, root).href))
const cjs = Object.keys(require(fileURLToPath(new URL(paths.require, root))))
const onlyEsm = esm.filter((k) => k !== '__esModule' && !cjs.includes(k))
const onlyCjs = cjs.filter((k) => k !== '__esModule' && !esm.includes(k))
if (onlyEsm.length || onlyCjs.length) {
  failures.push(
    `ESM/CJS surfaces differ — only-ESM [${onlyEsm.join(', ')}], only-CJS [${onlyCjs.join(', ')}]`,
  )
}

// AGENTS.md: credentials must never reach this package. The server entry of the
// core pulls credential handling into whatever bundle imports it, which here is
// always the browser.
for (const [kind, file] of Object.entries(paths)) {
  const url = new URL(file, root)
  const mod =
    kind === 'import' ? await import(url.href) : require(fileURLToPath(url))
  const leaked = [
    'LocationServiceConnector',
    'getClientConfig',
    'TokenProvider',
  ].filter((name) => name in mod)
  if (leaked.length) {
    failures.push(
      `${kind}: server-only export reachable — ${leaked.join(', ')}`,
    )
  }
}

report()
console.log('\npackage smoke passed — the entry point loads as ESM and CJS')
