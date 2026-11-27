/**
 * Reading a lexed segment the way a shell would: the real command word past env assignments,
 * wrappers (sudo, env, nohup, xargs, ...) and keywords; its positional arguments; and whether a
 * shell or interpreter takes its program from `-c`, a file, or stdin. hard-blocks.ts judges
 * commands with these.
 */

/** Options that take a value, per wrapper, so the value isn't mistaken for the command. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R', '--user', '--group'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  nohup: [],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  time: ['-f', '-o'],
  command: [],
  builtin: [],
  exec: ['-a'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a'],
  strace: ['-e', '-o', '-p', '-s', '-u', '-E'],
  ltrace: ['-e', '-o', '-p', '-s', '-u'],
}

/** Shell keywords that can sit in front of a command word. */
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'])

export interface Resolved {
  name: string
  args: string[]
}

export function basename(word: string): string {
  return word.includes('/') ? (word.split('/').pop() ?? word) : word
}

/** The real command of a segment, past env assignments, wrappers and keywords. */
export function resolve(words: string[]): Resolved | undefined {
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) {
      i++
      continue
    }
    const name = basename(word)
    const valueOpts = WRAPPERS[name]
    if (!valueOpts) return { name, args: words.slice(i + 1) }
    // `command -v x` only looks x up.
    if (name === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) return undefined
    i++
    while (i < words.length && (words[i] as string).startsWith('-')) {
      const opt = words[i++] as string
      if (opt === '--') break
      if (valueOpts.includes(opt)) i++
    }
    if (name === 'timeout') i++ // the duration
  }
  return undefined
}

/** Positional arguments, after options (and their values) are skipped. */
export function positionals(args: string[], valueOpts: string[] = []): string[] {
  const out: string[] = []
  let isAfterDashes = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (isAfterDashes || !arg.startsWith('-') || arg === '-') out.push(arg)
    else if (arg === '--') isAfterDashes = true
    else if (valueOpts.includes(arg)) i++
  }
  return out
}

export interface ShellArgs {
  isReadingStdin: boolean
  payload?: string
}

/** For sh/bash/...: does it run a `-c` string, a script file, or what arrives on stdin? */
export function shellArgs(args: string[]): ShellArgs {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-') return { isReadingStdin: true }
    if (arg === '--') return { isReadingStdin: i + 1 >= args.length }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      return { isReadingStdin: false, payload: args.slice(i + 1).find((a) => !a.startsWith('-')) }
    }
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg)) return { isReadingStdin: true }
    if (['-o', '-O', '+o', '+O', '--rcfile', '--init-file'].includes(arg)) i++
    else if (!arg.startsWith('-') && !arg.startsWith('+')) return { isReadingStdin: false }
  }
  return { isReadingStdin: true }
}

/** For python/perl/ruby/node: is the program read from stdin (no script, no inline code)? */
export function interpreterReadsStdin(name: string, args: string[]): boolean {
  const isInlineCode = (arg: string): boolean => {
    if (name === 'node') return ['-e', '--eval', '-p', '--print'].includes(arg)
    if (name === 'perl' || name === 'ruby') return /^-[a-zA-Z]*[eE]/.test(arg)
    return /^-[a-zA-Z]*[cm]$/.test(arg) // python -c code, -m module
  }
  const valueOpts = ['-W', '-X', '-I', '-r', '--require']
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-') return true
    if (arg === '--') return i + 1 >= args.length
    if (isInlineCode(arg)) return false
    if (valueOpts.includes(arg)) i++
    else if (!arg.startsWith('-')) return false
  }
  return true
}

export function isInterpreter(name: string): boolean {
  return /^(python(\d+(\.\d+)?)?|perl|ruby|node)$/.test(name)
}
