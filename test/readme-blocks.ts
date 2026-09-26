/**
 * The README's fenced code blocks, for the tests that hold its examples to a
 * rule (readme, maplibre-6). One parser, so two tests cannot disagree
 * about which blocks exist.
 */
export interface Block {
  /** The 1-based line of the opening fence. */
  line: number
  code: string
  /** The last non-empty line above the fence: the prose that introduces it. */
  preceding: string
}

export const codeBlocks = (markdown: string): Block[] => {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    // A fence may be indented, inside a list item: read it, and its body
    // without that indent, or an example there is invisible to every rule.
    const fence = /^(\s*)```\w*/.exec(lines[i])
    if (!fence) continue
    const indent = fence[1].length
    const start = i
    let before = start - 1
    while (before >= 0 && !lines[before].trim()) before--
    const end = lines.findIndex((l, j) => j > start && /^\s*```\s*$/.test(l))
    blocks.push({
      line: start + 1,
      code: lines
        .slice(start + 1, end)
        // Up to the fence's indent, as CommonMark strips: a line indented
        // less keeps its text rather than losing characters.
        .map((l) => l.replace(new RegExp(`^[ \\t]{0,${indent}}`), ''))
        .join('\n'),
      preceding: before >= 0 ? lines[before].trim() : '',
    })
    i = end
  }
  return blocks
}
