/**
 * A small shell lexer for the hard-block checks: just enough structure to tell a command word
 * from an argument, and a pipeline from a sequence. It is not a shell parser. It splits on
 * `|`, `|&`, `||`, `&&`, `;`, `&`, newlines and `( )`, removes quotes, separates redirections,
 * skips comments and here-doc bodies, and hands back the text of every `$(...)`, backtick and
 * `<(...)` / `>(...)` it meets so the caller can check those on their own.
 */

export interface Segment {
  /** Words with quotes removed. Quoted text stays inside the word it belongs to. */
  words: string[]
  /** Redirection targets (`> /dev/sda` gives `/dev/sda`). */
  redirects: string[]
}

export interface LexedCommand {
  /** Each pipeline is the segments joined by `|`; `&&`, `||`, `;`, `&` and newlines end one. */
  pipelines: Segment[][]
  /** Bodies of command substitutions and process substitutions, to be checked recursively. */
  nested: string[]
  /** The source with quoted text blanked out, for the few checks that stay regexes. */
  masked: string
  /** Index of the opening quote if a quote is never closed; the rest of the input is its word. */
  unterminatedAt?: number
}

/** Index just past the `)` that closes a `(` whose body starts at `start`. */
function closeParen(src: string, start: number): number {
  let depth = 1
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') i += 2
    else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      i = end === -1 ? src.length : end + 1
    } else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
      i++
    }
  }
  return src.length
}

/** Index just past the backtick that closes one opened at `open`. */
function closeBacktick(src: string, open: number): number {
  const end = src.indexOf('`', open + 1)
  return end === -1 ? src.length : end + 1
}

export function lexCommand(src: string): LexedCommand {
  const pipelines: Segment[][] = []
  const nested: string[] = []
  let masked = ''
  let pipeline: Segment[] = []
  let seg: Segment = { words: [], redirects: [] }
  let word = ''
  let hasWord = false
  let isRedirectTarget = false
  let isHeredocTarget = false
  let heredocs: { delim: string; isTabStripped: boolean }[] = []
  let isTabStripped = false
  let unterminatedAt: number | undefined

  const endWord = (): void => {
    if (hasWord) {
      if (isHeredocTarget) heredocs.push({ delim: word, isTabStripped })
      else if (isRedirectTarget) seg.redirects.push(word)
      else seg.words.push(word)
      isRedirectTarget = false
      isHeredocTarget = false
    }
    word = ''
    hasWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (seg.words.length > 0 || seg.redirects.length > 0) pipeline.push(seg)
    seg = { words: [], redirects: [] }
  }
  const endPipeline = (): void => {
    endSegment()
    if (pipeline.length > 0) pipelines.push(pipeline)
    pipeline = []
  }
  /** Take a `$(...)`-style substitution starting at `i` whose body starts at `bodyStart`. */
  const substitution = (i: number, bodyStart: number, isBacktick: boolean): number => {
    const end = isBacktick ? closeBacktick(src, i) : closeParen(src, bodyStart)
    const bodyEnd = src[end - 1] === (isBacktick ? '`' : ')') ? end - 1 : end
    nested.push(src.slice(bodyStart, bodyEnd))
    word += src.slice(i, end)
    hasWord = true
    return end
  }

  let i = 0
  while (i < src.length) {
    const start = i
    const c = src[i] as string
    const next = src[i + 1]

    if (c === '\\') {
      if (next !== '\n' && next !== undefined) {
        word += next
        hasWord = true
      }
      i += 2
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end === -1 ? src.length : end
      if (end === -1) unterminatedAt ??= i
      word += src.slice(i + 1, stop)
      hasWord = true
      i = stop + 1
      masked += ' '.repeat(Math.min(i, src.length) - start)
      continue
    } else if (c === '"') {
      i++
      hasWord = true
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1] as string)) {
          word += src[i + 1]
          i += 2
        } else if (src[i] === '$' && src[i + 1] === '(') i = substitution(i, i + 2, false)
        else if (src[i] === '`') i = substitution(i, i + 1, true)
        else word += src[i++]
      }
      if (i >= src.length) unterminatedAt ??= start
      i++
      masked += ' '.repeat(Math.min(i, src.length) - start)
      continue
    } else if (c === '$' && next === '(') {
      i = substitution(i, i + 2, false)
    } else if (c === '`') {
      i = substitution(i, i + 1, true)
    } else if ((c === '<' || c === '>') && next === '(') {
      endWord()
      i = substitution(i, i + 2, false)
      endWord()
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '\n') {
      endPipeline()
      i++
      for (const doc of heredocs) {
        while (i < src.length) {
          const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i)
          const line = src.slice(i, lineEnd)
          i = lineEnd + 1
          if ((doc.isTabStripped ? line.replace(/^\t+/, '') : line) === doc.delim) break
        }
      }
      heredocs = []
      // Here-doc bodies are data: blank them like quoted text.
      masked += `\n${' '.repeat(Math.min(i, src.length) - start - 1)}`
      continue
    } else if (c === '#' && !hasWord) {
      const lineEnd = src.indexOf('\n', i)
      i = lineEnd === -1 ? src.length : lineEnd
    } else if (c === '|') {
      if (next === '|') endPipeline()
      else endSegment()
      i += next === '|' || next === '&' ? 2 : 1
    } else if (c === '&' && next !== '>') {
      endPipeline()
      i += next === '&' ? 2 : 1
    } else if (c === ';' || c === '(' || c === ')') {
      endPipeline()
      i++
    } else if (c === '<' || c === '>' || c === '&') {
      // A bare fd number in front of the operator (`2>`) belongs to the redirection.
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      endWord()
      const op = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/.exec(src.slice(i))?.[0] ?? c
      i += op.length
      isRedirectTarget = true
      isHeredocTarget = op === '<<' || op === '<<-'
      isTabStripped = op === '<<-'
    } else {
      word += c
      hasWord = true
      i++
    }
    masked += src.slice(start, i)
  }
  endPipeline()

  return { pipelines, nested, masked, unterminatedAt }
}
