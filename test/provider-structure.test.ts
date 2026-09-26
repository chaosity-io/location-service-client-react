import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Two rules the provider's lifecycle depends on, checked on its syntax tree
 * rather than by a grep, which finds only the spellings its author thought of.
 *
 * - Everything that belongs to one configuration is reset when the
 *   configuration changes (#14). An organisation switch used to keep the old
 *   token and URL because that state sat in refs nothing reset.
 * - `getConfig` is called in one place, `refresh`, which decides from each
 *   outcome when the next call may start (#34, #35, #36). Each path that
 *   called it on its own asked as fast as the token route could answer.
 */

const here = dirname(fileURLToPath(import.meta.url))
const path = join(here, '../src/provider/LocationClientProvider.tsx')
const source = ts.createSourceFile(
  path,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

const provider = (() => {
  let found: ts.FunctionDeclaration | undefined
  walk(source, (n) => {
    if (
      ts.isFunctionDeclaration(n) &&
      n.name?.text === 'LocationClientProvider'
    )
      found = n
  })
  if (!found) throw new Error('LocationClientProvider not found')
  return found
})()

const lineOf = (n: ts.Node) =>
  source.getLineAndCharacterOfPosition(n.getStart()).line + 1

function within(n: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent)
    if (p === ancestor) return true
  return false
}

/**
 * Every call in the FILE to a hook that holds state, in any spelling
 * (`useRef`, `React.useState`…), with the names it binds. The whole file, not
 * the provider's body: a helper hook beside the provider would otherwise hold
 * state no guard below could see.
 */
const STATE_HOOK = /^(React\.)?use(Ref|State|Reducer)$/
const stateHooks = (() => {
  const out: {
    hook: string
    names: string[]
    line: number
    inProvider: boolean
  }[] = []
  walk(source, (n) => {
    if (!ts.isCallExpression(n)) return
    const callee = n.expression.getText()
    if (!STATE_HOOK.test(callee)) return
    const bound = ts.isVariableDeclaration(n.parent) ? n.parent.name : undefined
    const names = !bound
      ? ['<unbound>']
      : ts.isArrayBindingPattern(bound)
        ? bound.elements.flatMap((e) =>
            ts.isBindingElement(e) ? [e.name.getText()] : [],
          )
        : [bound.getText()]
    out.push({
      hook: callee.replace(/^React\./, ''),
      names,
      line: lineOf(n),
      inProvider: within(n, provider),
    })
  })
  return out
})()

/** Every function called inside the block of the `if` whose condition matches. */
function calledIn(condition: RegExp): Set<string> {
  const called = new Set<string>()
  let blocks = 0
  walk(provider, (n) => {
    if (!ts.isIfStatement(n) || !condition.test(n.expression.getText())) return
    blocks += 1
    walk(n.thenStatement, (c) => {
      if (ts.isCallExpression(c)) called.add(c.expression.getText())
    })
  })
  expect(blocks, `one if-block matching ${condition}`).toBe(1)
  return called
}

describe('per-configuration state (#14)', () => {
  /**
   * The provider's only refs, and why none of them belongs to a
   * configuration. A new one fails here: per-configuration state goes on
   * `ConfigState`, where a new configuration resets it by construction.
   */
  const REFS = new Map([
    ['getConfigRef', 'CLEARED: the latest getConfig prop, a function'],
    ['configRef', 'CLEARED: points at the installed ConfigState itself'],
    ['refreshRef', 'CLEARED: breaks the refresh/timer cycle, a function'],
  ])

  it('holds state only in the provider, and only with useRef and useState', () => {
    expect(stateHooks.length).toBeGreaterThan(0)
    const elsewhere = stateHooks
      .filter((h) => !h.inProvider || !['useRef', 'useState'].includes(h.hook))
      .map((h) => `LocationClientProvider.tsx:${h.line} ${h.hook} ${h.names}`)
    expect(elsewhere).toEqual([])
  })

  it("calls no hook but React's own, so no state can hide in another module", () => {
    // The guards here read this one file. A custom hook the provider called
    // could hold state in a module they never open, so it may call none.
    const REACT_HOOKS = [
      'useCallback',
      'useContext',
      'useEffect',
      'useMemo',
      'useRef',
      'useState',
    ]
    const custom: string[] = []
    walk(provider, (n) => {
      if (!ts.isCallExpression(n)) return
      const callee = n.expression.getText().replace(/^React\./, '')
      if (/^use[A-Z]/.test(callee) && !REACT_HOOKS.includes(callee))
        custom.push(`LocationClientProvider.tsx:${lineOf(n)} ${callee}`)
    })
    expect(custom).toEqual([])
  })

  it('keeps no ref beyond the three that hold no configuration', () => {
    const unexpected = stateHooks
      .filter((h) => h.hook === 'useRef')
      .flatMap((h) => h.names.map((name) => ({ name, line: h.line })))
      .filter((r) => !REFS.has(r.name))
      .map((r) => `LocationClientProvider.tsx:${r.line} ${r.name}`)
    expect(unexpected).toEqual([])
  })

  it('resets every piece of React state on both ways a configuration changes', () => {
    const setters = stateHooks
      .filter((h) => h.hook === 'useState')
      .map((h) => h.names[1])
    expect(setters).toContain('setSession')
    // Every useState binds its setter: one that does not cannot be reset.
    expect(setters.every(Boolean), 'every useState binds a setter').toBe(true)

    // A new configKey, in render; and getConfig answering with another apiUrl.
    // A setter moved into a helper fails here too, deliberately: the guard
    // reads only the block itself, so it fails closed.
    const onNewKey = calledIn(/Object\.is\(config\.key, configKey\)/)
    const onNewApiUrl = calledIn(/session\.apiUrl !== cfg\.apiUrl/)
    for (const setter of setters) {
      expect(onNewKey, `${setter} on a new configKey`).toContain(setter)
      expect(onNewApiUrl, `${setter} on another apiUrl`).toContain(setter)
    }
  })
})

describe('one call to getConfig (#34, #35, #36)', () => {
  /** The `useCallback` a node sits in: `const refresh = useCallback(…)`. */
  function ownerOf(n: ts.Node): string {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (
        ts.isVariableDeclaration(p) &&
        p.initializer &&
        ts.isCallExpression(p.initializer) &&
        p.initializer.expression.getText() === 'useCallback'
      )
        return p.name.getText()
    }
    return '?'
  }

  it('is read only to be called inside refresh, and nowhere else', () => {
    // Every READ of the prop and of its ref, not only the calls: an alias
    // (`const load = getConfigRef.current; load()`) is a second call site a
    // callee match cannot see.
    const reads: string[] = []
    walk(source, (n) => {
      const at = `@${lineOf(n)}`
      if (ts.isIdentifier(n) && n.text === 'getConfig') {
        const parent = n.parent
        // Declarations, not reads: the prop's type, and the destructured prop.
        if (
          (ts.isPropertySignature(parent) || ts.isBindingElement(parent)) &&
          parent.name === n
        )
          return
        if (
          ts.isCallExpression(parent) &&
          parent.expression.getText() === 'useRef'
        )
          return reads.push(`useRef(getConfig)${at}`)
        if (
          ts.isBinaryExpression(parent) &&
          parent.right === n &&
          parent.left.getText() === 'getConfigRef.current'
        )
          return reads.push(`getConfigRef.current = getConfig${at}`)
        if (ts.isArrayLiteralExpression(parent))
          return reads.push(`[getConfig] deps${at}`)
        return reads.push(`UNEXPECTED getConfig${at}`)
      }
      if (
        ts.isPropertyAccessExpression(n) &&
        n.getText() === 'getConfigRef.current'
      ) {
        const parent = n.parent
        if (
          ts.isBinaryExpression(parent) &&
          parent.left === n &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
          return reads.push(`assign getConfigRef.current${at}`)
        if (ts.isCallExpression(parent) && parent.expression === n)
          return reads.push(`${ownerOf(n)} calls getConfigRef.current${at}`)
        return reads.push(`UNEXPECTED getConfigRef.current${at}`)
      }
    })

    const plain = reads.map((r) => r.replace(/@\d+$/, ''))
    expect(plain.filter((r) => r.startsWith('UNEXPECTED'))).toEqual([])
    expect(
      plain.filter((r) => r.includes('calls getConfigRef.current')),
    ).toEqual(['refresh calls getConfigRef.current'])
    expect(plain.sort()).toEqual(
      [
        '[getConfig] deps',
        'assign getConfigRef.current',
        'getConfigRef.current = getConfig',
        'refresh calls getConfigRef.current',
        'useRef(getConfig)',
      ].sort(),
    )
  })
})
