/**
 * Hard-blocked commands: always refused, whatever the filter mode.
 *
 * This is a guardrail against accidents and obvious misuse, not a security boundary. It reads
 * the command string, and string-level checks can always be evaded: eval of base64, an alias,
 * writing a script and running it, or `cd / && rm -rf *` (catching that needs cwd tracking).
 * Treat a pass as "not obviously destructive", nothing more.
 *
 * Rules match on command structure, not substrings: the command is lexed into pipelines and
 * segments (shell-lex.ts), leading env assignments and wrappers (sudo, env, nohup, xargs, ...)
 * are stripped, and each segment is judged by its command word and arguments. Quoted text is
 * an argument, so `git commit -m "reboot later"` passes; the payloads of `sh -c`, `eval`,
 * `$(...)` and backticks, and the remote command of `ssh host ...`, are checked recursively.
 */

import { posix } from 'node:path'
import {
  basename,
  interpreterReadsStdin,
  isInterpreter,
  positionals,
  resolve,
  shellArgs,
} from './command-words'
import { lexCommand, type Segment } from './shell-lex'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])
const SYSTEMCTL_POWER = new Set(['poweroff', 'reboot', 'halt', 'kexec'])

/** rm targets refused with a recursive flag (after trailing `/` and `/*` are stripped). */
const RM_WIPE_TARGETS = new Set([
  '/',
  '~',
  '$HOME',
  '$' + '{HOME}', // the literal text `${HOME}`, not a template
  '/home',
  '/root',
  ...'etc usr var boot bin sbin lib lib64 opt srv sys proc dev'.split(' ').map((d) => `/${d}`),
])

/**
 * A recursive rm of a home directory, or of anything directly in one (`~/Projects`, `~/.ssh`,
 * `/home/nick/src`): one level up from what an agent's own build directories look like.
 */
const HOME_TREE =
  /^(~[^/]*|\$HOME|\$\{HOME\})(\/[^/]+)?$|^\/(home|Users)\/[^/]+(\/[^/]+)?$|^\/root\/[^/]+$/

function isWipeTarget(target: string): boolean {
  return RM_WIPE_TARGETS.has(target) || HOME_TREE.test(target)
}

const FORK_BOMB = /:\(\)\s*\{/
/** ssh options that take a value, so the value isn't mistaken for the host. */
const SSH_VALUE_OPTS = '-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w'.split(' ')
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk)/
const MAX_DEPTH = 8

function normalizeRmTarget(target: string): string {
  let t = posix.normalize(target.replace(/\/{2,}/g, '/'))
  while (true) {
    if (t.endsWith('/*')) t = t.slice(0, -2) || '/'
    else if (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1)
    else return t
  }
}

function isFetch(name: string | undefined): boolean {
  return name === 'curl' || name === 'wget'
}

/** Does this segment run curl or wget, itself or inside its `( ... )` / `{ ...; }` group? */
function segmentFetches(seg: Segment): boolean {
  return isFetch(resolve(seg.words)?.name) || seg.groups.some(runsFetch)
}

/** Does any segment of `body` run curl or wget? */
function runsFetch(body: string): boolean {
  return lexCommand(body).pipelines.some((p) => p.some(segmentFetches))
}

/** The body of `text` if, trimmed, it is one whole `$(...)` or backtick substitution. */
function substitutionBody(text: string): string | undefined {
  const t = text.trim()
  if (t.length > 1 && t.startsWith('`') && t.indexOf('`', 1) === t.length - 1) return t.slice(1, -1)
  if (!t.startsWith('$(')) return undefined
  const body = lexCommand(t).nested[0]
  return body !== undefined && `$(${body})` === t ? body : undefined
}

function isRemoteSubstitution(text: string): boolean {
  const body = substitutionBody(text)
  return body !== undefined && runsFetch(body)
}

/** A `<(...)` argument whose body runs curl or wget. */
function hasRemoteProcessSub(args: string[]): boolean {
  return args.some((a) => a.startsWith('<(') && a.endsWith(')') && runsFetch(a.slice(2, -1)))
}

function checkSsh(args: string[], depth: number): string | undefined {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    if (SSH_VALUE_OPTS.includes(args[i] as string)) i++
    i++
  }
  const remote = args.slice(i + 1).join(' ')
  return remote ? checkHardBlocks(remote, depth + 1) : undefined
}

function checkFind(args: string[]): string | undefined {
  const end = args.findIndex((a) => /^[-(!]/.test(a))
  const starts = (end === -1 ? args : args.slice(0, end)).map(normalizeRmTarget)
  const target = starts.find(isWipeTarget)
  if (!target) return undefined
  const isDeleting =
    args.includes('-delete') ||
    args.some((a, j) => FIND_EXEC.has(a) && basename(args[j + 1] ?? '') === 'rm')
  return isDeleting ? `find delete of ${target}` : undefined
}

function checkRm(args: string[]): string | undefined {
  if (args.includes('--no-preserve-root')) return 'rm --no-preserve-root'
  const isRecursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))
  for (const target of positionals(args).map(normalizeRmTarget)) {
    if (target === '/') return 'rm of the filesystem root'
    if (isRecursive && isWipeTarget(target)) return `recursive rm of ${target}`
  }
  return undefined
}

function checkSegment(seg: Segment, isAfterFetch: boolean, depth: number): string | undefined {
  if (seg.redirects.some((t) => DISK_DEVICE.test(t))) return 'overwrite disk device'
  for (const group of seg.groups) {
    const rule = checkHardBlocks(group, depth + 1)
    if (rule) return rule
  }

  const cmd = resolve(seg.words)
  if (!cmd) return undefined
  const { name, args } = cmd

  if (SHELLS.has(name)) {
    if (hasRemoteProcessSub(args)) return 'run remote script via process substitution'
    const shell = shellArgs(args)
    if (shell.payload !== undefined && isRemoteSubstitution(shell.payload)) {
      return 'run remote script via -c'
    }
    if (shell.payload !== undefined) {
      const inner = checkHardBlocks(shell.payload, depth + 1)
      if (inner) return inner
    }
    if (shell.isReadingStdin && isAfterFetch) return 'pipe remote script to shell'
    return undefined
  }
  if (isInterpreter(name)) {
    return isAfterFetch && interpreterReadsStdin(name, args)
      ? 'pipe remote script to interpreter'
      : undefined
  }
  if ((name === 'source' || name === '.') && hasRemoteProcessSub(args)) {
    return 'run remote script via process substitution'
  }
  if (name === 'eval') {
    const code = args.join(' ')
    return isRemoteSubstitution(code) ? 'eval of remote script' : checkHardBlocks(code, depth + 1)
  }
  if (name === 'ssh') return checkSsh(args, depth)

  if (POWER.has(name)) return `power command (${name})`
  if (name === 'systemctl') {
    const sub = positionals(args, ['-H', '-M', '--host', '--machine'])[0]
    if (sub && SYSTEMCTL_POWER.has(sub)) return `power command (systemctl ${sub})`
  }
  if ((name === 'init' || name === 'telinit') && ['0', '6'].includes(args[0] ?? '')) {
    return `power command (${name} ${args[0]})`
  }

  if (name === 'rm') return checkRm(args)
  if (name === 'find') return checkFind(args)
  if (/^mkfs(\..+)?$/.test(name)) return 'format filesystem'
  if (name === 'dd' && args.some((a) => a.startsWith('of=/dev/'))) return 'direct disk write'
  if (
    name === 'chmod' &&
    args.some((a) => /^0?777$/.test(a)) &&
    args.some((a) => a.startsWith('/'))
  ) {
    return 'world-writable root path'
  }
  if (name === 'pkill') {
    const isKill = args.some((a) => ['-9', '-KILL', '-SIGKILL'].includes(a))
    if (isKill && positionals(args).some((a) => /^(init|systemd)\b/.test(a))) return 'kill init'
  }
  return undefined
}

/**
 * Check a shell command against the hard-block rules.
 * Returns the name of the rule that fired, or undefined if none did.
 */
export function checkHardBlocks(command: string, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return 'command nested too deeply to check'

  const lexed = lexCommand(command)
  if (FORK_BOMB.test(lexed.masked)) return 'fork bomb'
  // An unterminated quote: also judge the command as if it stopped before that quote, so the
  // stray word can't pass for an argument (`curl x | sh "` would otherwise run a script "").
  if (lexed.unterminatedAt !== undefined) {
    const rule = checkHardBlocks(command.slice(0, lexed.unterminatedAt), depth)
    if (rule) return rule
  }

  for (const pipeline of lexed.pipelines) {
    let isAfterFetch = false
    for (const seg of pipeline) {
      const rule = checkSegment(seg, isAfterFetch, depth)
      if (rule) return rule
      if (segmentFetches(seg)) isAfterFetch = true
    }
  }
  for (const inner of lexed.nested) {
    const rule = checkHardBlocks(inner, depth + 1)
    if (rule) return rule
  }
  return undefined
}
