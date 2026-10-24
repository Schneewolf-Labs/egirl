import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { log } from '../../../util/logger'

/**
 * One program, run under bubblewrap with every namespace unshared: no network, no host
 * filesystem except a read-only /usr (plus the interpreter's own directories), a fresh /tmp,
 * and a scratch /work that is deleted afterwards. Limits: wall-clock timeout, address space,
 * and the size of any file it writes.
 */
export interface SandboxRun {
  /** Absolute host path of the interpreter binary. */
  binaryPath: string
  args: (script: string) => string[]
  extension: string
  readPaths: string[]
  code: string
  timeoutMs: number
  memoryMb: number
}

export interface SandboxResult {
  stdout: string
  stderr: string
  /** Exit code, or undefined when it was killed. */
  exitCode?: number
  isTimedOut: boolean
  isTruncated: boolean
}

/** Per stream. A program that prints more is cut off, not failed. */
export const MAX_OUTPUT = 20_000
const MAX_FILE_MB = 64
const HARD_DEADLINE_SLACK_MS = 2000
const SYSTEM_DIRS = ['/bin', '/lib', '/lib64', '/sbin']
const SYSTEM_FILES = ['/etc/ld.so.cache', '/etc/localtime']

/** Why the sandbox can't run here, or undefined when it can. */
export function sandboxUnavailable(): string | undefined {
  if (process.platform !== 'linux') return `the sandbox needs Linux (this is ${process.platform})`
  if (!Bun.which('bwrap')) return 'bubblewrap (bwrap) is not installed'
  const probe = spawnSync('bwrap', [
    '--unshare-all',
    '--ro-bind',
    '/usr',
    '/usr',
    ...systemBinds(),
    '--',
    '/usr/bin/true',
  ])
  if (probe.status !== 0) {
    const why = probe.stderr?.toString().trim() || `exit ${probe.status}`
    return `bwrap cannot create a sandbox here (${why}); unprivileged user namespaces may be disabled`
  }
  return undefined
}

/** Resolve an interpreter to an absolute, symlink-free host path. */
export function resolveBinary(binary: string): string | undefined {
  const found = binary.startsWith('/') ? binary : Bun.which(binary)
  if (!found) return undefined
  try {
    return realpathSync(found)
  } catch {
    return undefined
  }
}

function systemBinds(): string[] {
  return [
    ...SYSTEM_DIRS.flatMap((d) => ['--ro-bind-try', d, d]),
    ...SYSTEM_FILES.flatMap((f) => ['--ro-bind-try', f, f]),
  ]
}

export function bwrapArgs(run: SandboxRun, workDir: string, script: string): string[] {
  const extra = [...run.readPaths]
  const binDir = dirname(run.binaryPath)
  if (!binDir.startsWith('/usr/')) extra.push(binDir)
  const limits = `ulimit -v ${run.memoryMb * 1024} && ulimit -f ${MAX_FILE_MB * 1024}`
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/work',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--ro-bind',
    '/usr',
    '/usr',
    ...systemBinds(),
    ...extra.flatMap((p) => ['--ro-bind-try', p, p]),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    workDir,
    '/work',
    '--chdir',
    '/work',
    '--',
    '/bin/sh',
    '-c',
    `${limits} && exec "$@"`,
    'sh',
    run.binaryPath,
    ...run.args(script),
  ]
}

export function runSandboxed(run: SandboxRun): Promise<SandboxResult> {
  const workDir = mkdtempSync(join(tmpdir(), 'egirl-run-code-'))
  const name = `main${run.extension}`
  writeFileSync(join(workDir, name), run.code)

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let isTruncated = false
    let isTimedOut = false
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const proc = spawn('bwrap', bwrapArgs(run, workDir, `/work/${name}`), {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so the kill reaches bwrap and everything under it.
      detached: true,
    })

    const settle = (result: Omit<SandboxResult, 'isTruncated'>) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      rmSync(workDir, { recursive: true, force: true })
      resolve({ ...result, isTruncated })
    }

    const kill = () => {
      if (proc.pid === undefined) return
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT) {
        isTruncated = true
        return current
      }
      const next = current + chunk.toString()
      if (next.length > MAX_OUTPUT) isTruncated = true
      return next.slice(0, MAX_OUTPUT)
    }

    timers.push(
      setTimeout(() => {
        isTimedOut = true
        kill()
        timers.push(
          setTimeout(() => {
            log.warn('tools', 'run_code sandbox never reported exit after SIGKILL; abandoning it')
            settle({ stdout, stderr, isTimedOut })
          }, HARD_DEADLINE_SLACK_MS),
        )
      }, run.timeoutMs),
    )

    proc.stdout.on('data', (d: Buffer) => {
      stdout = append(stdout, d)
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr = append(stderr, d)
    })
    proc.on('error', (error) => {
      settle({
        stdout,
        stderr: `${stderr}failed to start the sandbox: ${error.message}`,
        isTimedOut,
      })
    })
    proc.on('close', (code) => {
      settle({ stdout, stderr, exitCode: code ?? undefined, isTimedOut })
    })
  })
}
