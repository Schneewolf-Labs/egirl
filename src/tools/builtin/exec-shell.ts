/**
 * How execute_command runs a command: from a script file, under bash, with no stdin.
 *
 * It used to be `sh -c "<command>"` with stdin left as an open pipe, and three kinds of
 * failure in Jaeger's traces came from that, not from the commands:
 *  - `pkill -f build/petz4` killed its own shell: the pattern is in `sh -c`'s command line,
 *    so the cleanup step of a command took the command down with it (SIGKILL, output lost);
 *  - bash syntax (`<<<`, `[[ ]]`, `&>`) failed under /bin/sh, which is dash on Debian/Ubuntu:
 *    "Syntax error: redirection unexpected". Models write bash;
 *  - a program that reads stdin waited on a pipe nobody would ever write to, until timeout.
 * Run from a file, the shell's command line is just the file's path, which no pattern in the
 * command matches; bash is used where it exists; stdin is /dev/null.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '../../util/logger'

const BASH_PATHS = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']

let shellPath: string | undefined

function findShell(): string {
  shellPath ??=
    BASH_PATHS.find((p) => statSync(p, { throwIfNoEntry: false })?.isFile()) ?? '/bin/sh'
  return shellPath
}

export interface ShellRun {
  file: string
  args: string[]
  /** Remove the script once the command is done. */
  cleanup(): void
}

/** The command as a script for the shell to run; undefined on Windows, which keeps `shell: true`. */
export function shellRun(command: string): ShellRun | undefined {
  if (process.platform === 'win32') return undefined
  const dir = mkdtempSync(join(tmpdir(), 'egirl-cmd-'))
  const script = join(dir, 'command.sh')
  writeFileSync(script, `${command}\n`, { mode: 0o600 })
  return {
    file: findShell(),
    args: [script],
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        log.debug('tools', `Could not remove ${dir}: ${error}`)
      }
    },
  }
}

const TIMEOUT_WITHOUT_KILL = /(^|[\s;&|(])timeout\s+(?!.*(-k|--kill-after|-s\s*(KILL|9)\b))/

/**
 * Said when a command that wrapped its program in `timeout N` ran out egirl's own clock: the
 * wrapper sent SIGTERM at N, and the program outlived it. An SDL program turns SIGTERM into a
 * quit event, which one stuck in a loop never reads; Jaeger lost 16 runs of his game to it.
 */
export function timeoutHint(command: string): string | undefined {
  if (!TIMEOUT_WITHOUT_KILL.test(command)) return undefined
  return '`timeout N` only sends SIGTERM, and this program outlived it (an SDL program, for one, turns SIGTERM into a quit event a stuck loop never reads). `timeout -k 5 N` follows it with SIGKILL.'
}
