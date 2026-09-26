import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { codeBlocks } from './readme-blocks'

/**
 * maplibre-gl 6.4.1 or later.
 *
 * GHSA-jrc7-96c5-q579 is a critical XSS in maplibre-gl up to 6.4.0: its
 * sanitizer skipped the attribute after each one it removed, so an attribution
 * string carrying two event handlers kept the second. 6.4.1 is the first
 * release with the fix. There is no 5.x one. So the peer range, the
 * devDependency and every copy the lockfile installs start at 6.4.1, and the
 * peer admits only the major this suite installs.
 *
 * maplibre 6 also changed how it is loaded. It is ESM only, with no default
 * export, and it finds its worker from `import.meta.url`, which a bundler
 * rewrites. So `import maplibregl from 'maplibre-gl'` gets nothing, and a map
 * built without `setWorkerUrl` mounts and draws no tile ("Worker failed to
 * load", measured under Vite 8 and Next 16). The README's examples are what
 * applications copy, so they are held to that shape here.
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (path: string) => readFileSync(join(here, '..', path), 'utf8')

const FIRST_PATCHED = [6, 4, 1] as const

const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const installed: string = JSON.parse(
  read('node_modules/maplibre-gl/package.json'),
).version

const parse = (version: string) => version.split('.').map(Number)

const atLeastPatched = (version: string) => {
  const v = parse(version)
  for (let i = 0; i < FIRST_PATCHED.length; i++) {
    if (v[i] !== FIRST_PATCHED[i]) return v[i] > FIRST_PATCHED[i]
  }
  return true
}

/** The floor of a plain caret range, or null for any other shape. */
const caretFloor = (range: string) =>
  /^\^(\d+\.\d+\.\d+)$/.exec(range.trim())?.[1] ?? null

describe('maplibre-gl version', () => {
  it.each([
    ['peerDependencies', pkg.peerDependencies['maplibre-gl']],
    ['devDependencies', pkg.devDependencies['maplibre-gl']],
  ])('%s is a caret range from 6.4.1', (_field, range: string) => {
    const floor = caretFloor(range)
    expect(floor, `${range} is not a plain ^x.y.z range`).not.toBeNull()
    expect(atLeastPatched(floor!), `${range} admits a vulnerable release`).toBe(
      true,
    )
  })

  it('peers only the major this suite installs', () => {
    const floor = caretFloor(pkg.peerDependencies['maplibre-gl'])!
    expect(parse(floor)[0]).toBe(parse(installed)[0])
  })

  it('installs no vulnerable copy anywhere in the lockfile', () => {
    const copies = Object.entries(
      lock.packages as Record<string, { version: string }>,
    ).filter(([path]) => /(^|\/)node_modules\/maplibre-gl$/.test(path))
    expect(copies.length).toBeGreaterThan(0)
    expect(
      copies
        .filter(([, entry]) => !atLeastPatched(entry.version))
        .map(([path, entry]) => `${path}@${entry.version}`),
    ).toEqual([])
  })
})

interface Usage {
  /** A default import, `require('maplibre-gl')` or `import x = require(…)`: 6.x has none. */
  v5Loads: string[]
  /** The block calls `new Map(…)` through its maplibre binding. */
  buildsMap: boolean
  setsWorker: boolean
}

/**
 * How one code block uses maplibre-gl, read from its syntax tree.
 *
 * A block that imports nothing from maplibre-gl is read as if `maplibregl`
 * were its namespace, which is the name every example here gives it. So a
 * fragment that writes `new maplibregl.Map` is held to the worker rule too:
 * whoever copies it adds the import and gets a map with no tiles.
 */
const maplibreUsage = (code: string): Usage => {
  const source = ts.createSourceFile(
    'block.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const usage: Usage = { v5Loads: [], buildsMap: false, setsWorker: false }
  const namespaces = new Set<string>()
  // local name → exported name, for `import { Map as M, setWorkerUrl }`
  const named = new Map<string, string>()

  for (const statement of source.statements) {
    // `import maplibregl = require('maplibre-gl')`: a require by another name.
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression) &&
      statement.moduleReference.expression.text === 'maplibre-gl'
    ) {
      usage.v5Loads.push(`import ${statement.name.text} = require`)
      namespaces.add(statement.name.text)
      continue
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'maplibre-gl'
    )
      continue
    const clause = statement.importClause
    // A default import is refused, but it is still read as the namespace its
    // author meant, so its `new x.Map` is seen here too.
    if (clause?.name) {
      usage.v5Loads.push(`import ${clause.name.text}`)
      namespaces.add(clause.name.text)
    }
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    } else if (bindings) {
      for (const element of bindings.elements) {
        named.set(
          element.name.text,
          (element.propertyName ?? element.name).text,
        )
      }
    }
  }
  if (namespaces.size === 0 && named.size === 0) namespaces.add('maplibregl')

  /** The maplibre export an expression names, if it names one. */
  const exportOf = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return named.get(node.text)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      return node.name.text
    return undefined
  }

  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && exportOf(node.expression) === 'Map')
      usage.buildsMap = true
    if (ts.isCallExpression(node)) {
      if (exportOf(node.expression) === 'setWorkerUrl') usage.setsWorker = true
      const [arg] = node.arguments
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        arg &&
        ts.isStringLiteral(arg) &&
        arg.text === 'maplibre-gl'
      )
        usage.v5Loads.push("require('maplibre-gl')")
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return usage
}

describe('the README on maplibre 6', () => {
  const blocks = codeBlocks(read('README.md'))

  it('has maplibre examples to check', () => {
    expect(
      blocks.filter((b) => /from ['"]maplibre-gl['"]/.test(b.code)).length,
    ).toBeGreaterThan(1)
  })

  it('never loads maplibre-gl as a default import or with require()', () => {
    expect(
      blocks.flatMap((b) =>
        maplibreUsage(b.code).v5Loads.map((l) => `README.md:${b.line} ${l}`),
      ),
    ).toEqual([])
  })

  it('sets the worker URL in every block that builds a map', () => {
    expect(
      blocks
        .filter((b) => {
          const usage = maplibreUsage(b.code)
          return usage.buildsMap && !usage.setsWorker
        })
        .map((b) => `README.md:${b.line}`),
    ).toEqual([])
  })
})
