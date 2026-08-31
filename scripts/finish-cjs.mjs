// Marks dist/cjs as CommonJS (#16).
//
// The package root is "type": "module", which would otherwise make Node parse
// dist/cjs/*.js as ESM and fail on `exports.x =`. A nested package.json with
// {"type":"commonjs"} scopes the override to that directory — the standard
// dual-package layout, and the reason the `require` condition in the exports
// map can point at plain .js instead of .cjs.
import { writeFileSync } from 'node:fs'

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
)
