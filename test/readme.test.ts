import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The README's examples run on any plan (#27).
 *
 * The service gates some map options by plan — terrain, 3D buildings,
 * satellite imagery, traffic, contours, travel modes, a political view — and
 * answers an application whose plan lacks one with 403
 * `FeatureNotEntitledException`. "Complete Example with MapLibre" is the one a
 * reader copies whole, and it asked for `Terrain3D` and `Buildings3D` inside an
 * async IIFE with no `catch`: on a plan without them the style request was
 * refused, the rejection went unhandled, and the reader got an empty box.
 *
 * So a code block may ask for a gated option only when the prose right above
 * it says it needs a plan feature, and the complete example must put a failure
 * on screen.
 */

const here = dirname(fileURLToPath(import.meta.url))
const README = readFileSync(join(here, '../README.md'), 'utf8')

/**
 * What asks for a plan feature, as the service's gate names it (#27): the map
 * features, and rich place data — the `GeoPlaces` details the example's
 * adapter takes, and the `AdditionalFeatures` values behind them.
 */
const GATED =
  /Terrain3D|Buildings3D|Hillshade|Satellite|Hybrid|traffic|contour|travelModes|politicalView|\bterrain\s*:|\bbuildings\s*:|TerrainControl|setTerrain\(|\b(access|contact|timeZone)\s*:|['"](Access|Contact|Phonemes|TimeZone)['"]/

interface Block {
  line: number
  code: string
  marked: boolean
}

/** Fenced code blocks, and whether the last prose line above names "plan feature". */
const codeBlocks = (markdown: string): Block[] => {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^```\w*/.test(lines[i])) continue
    const start = i
    let before = start - 1
    while (before >= 0 && !lines[before].trim()) before--
    const end = lines.findIndex((l, j) => j > start && /^```\s*$/.test(l))
    blocks.push({
      line: start + 1,
      code: lines.slice(start + 1, end).join('\n'),
      marked: before >= 0 && /plan feature/i.test(lines[before]),
    })
    i = end
  }
  return blocks
}

describe('the README', () => {
  const blocks = codeBlocks(README)

  it('has code blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(3)
  })

  it('asks for a plan feature only in an example marked as needing it', () => {
    const offending = blocks
      .filter((b) => !b.marked && GATED.test(b.code))
      .map((b) => `README.md:${b.line} ${b.code.match(GATED)![0]}`)
    expect(offending).toEqual([])
  })

  it('names a gated option nowhere else — prose included', () => {
    // The ticket's own grep, plus the bare word: prose that offers terrain as
    // a routine switch presents it as universal just as an example does.
    const named = new RegExp(`${GATED.source}|\\bterrain\\b`, 'i')
    const lines = README.split('\n')
    const allowed = new Set<number>()
    for (const b of blocks.filter((b) => b.marked)) {
      let marker = b.line - 2
      while (!lines[marker].trim()) marker--
      allowed.add(marker + 1)
      const size = b.code.split('\n').length
      for (let n = b.line; n <= b.line + size + 1; n++) allowed.add(n)
    }
    const offending = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([n, l]) => named.test(l) && !allowed.has(n))
      .map(([n, l]) => `README.md:${n} ${l.trim()}`)
    expect(offending).toEqual([])
  })

  it('puts a failed map on screen in the complete example', () => {
    const start = README.indexOf('## Complete Example with MapLibre')
    expect(start).toBeGreaterThan(-1)
    const example = codeBlocks(README.slice(start))[0].code

    // The async IIFE's rejection is caught…
    expect(example).toMatch(/\}\)\(\)\s*\.catch\(/)
    // …into state that the component renders.
    const setter = example.match(/\.catch\([^)]*\)\s*=>\s*\{?[^}]*?(set\w+)\(/)
    expect(setter, 'the catch stores the error in state').not.toBeNull()
    // …after removing a map already built, so a failure that came later —
    // a control, the geocoder — does not leave an instance nothing can reach.
    expect(example).toMatch(
      /\.catch\([^)]*\)\s*=>\s*\{[^}]*map\.current\?\.remove\(\)/,
    )
    expect(example).toMatch(
      /new maplibregl\.Map\([\s\S]*?\}\)\s*(\/\/[^\n]*\n\s*)*map\.current = instance/,
    )
    const state = setter![1].replace(/^set/, '')
    expect(example).toMatch(
      new RegExp(`if \\(${state[0].toLowerCase()}${state.slice(1)}\\) return`),
    )
  })
})
