import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The provider's client is declared by hand (#26).
 *
 * `LocationClient` and `SendOptions` restate the core client's surface rather
 * than import it — all but `send`, which is the core's own type (see the
 * per-command block at the end) — because the provider wraps the client to
 * refresh tokens first, and a class with private fields is not structurally
 * assignable. The cost of a hand copy is that it does not move when the core
 * does. The core gained `overallTimeoutMs` in 0.8.0 and `verifyAddress` after
 * that, and
 * neither reached `useLocationClient().client`: one was a compile error for
 * an option the wrapper passes on anyway, the other was simply absent.
 *
 * So this compares the two with TypeScript's own checker, against the core
 * this package builds with: every name, and every shared name's type, both
 * ways. `keyof` leaves out private and protected members, which is exactly
 * the public surface. Moving the core devDependency (see
 * AGENTS.md) is when this goes red, which is when the provider has to follow.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** The names in a string-literal union type alias declared in `source`. */
function namesIn(source: string, alias: string): string[] {
  const file = join(here, '__core-surface__.ts')
  const config = ts.getParsedCommandLineOfConfigFile(
    join(here, '../tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )
  if (!config) throw new Error('tsconfig.json did not parse')
  const options = { ...config.options, noEmit: true, rootDir: join(here, '..') }

  const host = ts.createCompilerHost(options)
  const readFile = host.readFile
  const fileExists = host.fileExists
  const getSourceFile = host.getSourceFile
  host.readFile = (f) => (f === file ? source : readFile(f))
  host.fileExists = (f) => f === file || fileExists(f)
  host.getSourceFile = (f, v, ...rest) =>
    f === file
      ? ts.createSourceFile(f, source, v)
      : getSourceFile(f, v, ...rest)

  const program = ts.createProgram([file], options, host)
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
  if (errors.length) throw new Error(errors.join('\n'))

  const checker = program.getTypeChecker()
  const symbol = checker
    .getSymbolsInScope(program.getSourceFile(file)!, ts.SymbolFlags.TypeAlias)
    .find((s) => s.name === alias)
  if (!symbol) throw new Error(`${alias} not found`)
  const type = checker.getDeclaredTypeOfSymbol(symbol)
  const members = type.isUnion() ? type.types : [type]
  return members
    .filter((t): t is ts.StringLiteralType => t.isStringLiteral())
    .map((t) => t.value)
    .sort()
}

const SOURCE = `
import type { GeoPlacesClient, SendOptions as CoreSendOptions } from '@chaosity/location-client'
import type { LocationClient, SendOptions } from '../src/index.js'

type CoreMembers = keyof GeoPlacesClient
type MissingMembers = Exclude<keyof GeoPlacesClient, keyof LocationClient>

// A name both declare is not enough: its type must match, in both directions.
type Shared = keyof GeoPlacesClient & keyof LocationClient
type MismatchedMembers = {
  [K in Shared]: [LocationClient[K]] extends [GeoPlacesClient[K]]
    ? [GeoPlacesClient[K]] extends [LocationClient[K]] ? never : K
    : K
}[Shared]

type CoreOptions = keyof CoreSendOptions
type MissingOptions = Exclude<keyof CoreSendOptions, keyof SendOptions>

type SharedOptions = keyof CoreSendOptions & keyof SendOptions
type MismatchedOptions = {
  [K in SharedOptions]-?: [CoreSendOptions[K]] extends [SendOptions[K]]
    ? [SendOptions[K]] extends [CoreSendOptions[K]] ? never : K
    : K
}[SharedOptions]
`

describe('the provider covers the core client it builds with', () => {
  it('found the core surface, so an empty comparison cannot pass', () => {
    expect(namesIn(SOURCE, 'CoreMembers')).toEqual(
      expect.arrayContaining(['send', 'getAppConfig']),
    )
    expect(namesIn(SOURCE, 'CoreOptions')).toEqual(
      expect.arrayContaining(['signal', 'timeoutMs']),
    )
  }, 60_000)

  it('has every public member of GeoPlacesClient', () => {
    expect(namesIn(SOURCE, 'MissingMembers')).toEqual([])
  }, 60_000)

  it('takes every option GeoPlacesClient.send takes', () => {
    expect(namesIn(SOURCE, 'MissingOptions')).toEqual([])
  }, 60_000)

  it('types every shared member as the core does', () => {
    expect(namesIn(SOURCE, 'MismatchedMembers')).toEqual([])
  }, 60_000)

  it('types every shared option as the core does', () => {
    expect(namesIn(SOURCE, 'MismatchedOptions')).toEqual([])
  }, 60_000)
})

// `send` resolves with each command's own output (core #68). The comparison
// above cannot see it: one generic `send<TInput, TOutput>` and the core's
// pair of overloads are assignable to each other both ways, so the provider's
// `send` kept answering `unknown` while the core's inferred. So this compiles
// a call per command against both and requires the same type, against the
// core this package builds with — and asks the installed core which commands
// it has, so a command it adds is checked too.
const CORE_COMMANDS = Object.keys(
  await import('@chaosity/location-client'),
).filter((k) => /^[A-Z]\w*Command$/.test(k))

const SEND_SOURCE = `
import type * as C from '@chaosity/location-client'
import type { LocationClient } from '../src/index.js'

declare const core: C.GeoPlacesClient
declare const ours: LocationClient
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
${CORE_COMMANDS.map(
  (name) => `
declare const cmd${name}: C.${name}
const core${name} = core.send(cmd${name})
const ours${name} = ours.send(cmd${name})
type Mismatch${name} = Equal<typeof core${name}, typeof ours${name}> extends true ? never : '${name}'`,
).join('')}
type SendCommands = ${CORE_COMMANDS.map((n) => `'${n}'`).join(' | ')}
type SendMismatches = never ${CORE_COMMANDS.map((n) => `| Mismatch${n}`).join(' ')}
type CoreInfers = Equal<Awaited<typeof coreAutocompleteCommand>, unknown> extends true ? 'no' : 'yes'
`

// Below core 0.13.0 the core's `send` answers `unknown` too, so the
// comparison is equal whatever the provider declares: it would pass without
// proving anything. It runs once the core devDependency's `send` infers, and
// is reported as skipped until then.
const CORE_INFERS = namesIn(SEND_SOURCE, 'CoreInfers')[0] === 'yes'

describe('the provider’s send answers as the core’s does, per command', () => {
  it('found the core’s commands, so an empty comparison cannot pass', () => {
    expect(namesIn(SEND_SOURCE, 'SendCommands')).toEqual(
      expect.arrayContaining(['AutocompleteCommand', 'SearchTextCommand']),
    )
  }, 60_000)

  it.skipIf(!CORE_INFERS)(
    'resolves every command to the type the core’s send does (skipped while the core devDependency’s send answers unknown)',
    () => {
      expect(namesIn(SEND_SOURCE, 'SendMismatches')).toEqual([])
    },
    60_000,
  )
})
