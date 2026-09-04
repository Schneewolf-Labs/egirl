import { spawn } from 'child_process'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run a git command and capture its output. Never throws: a spawn failure or a timeout comes
 * back as a non-zero code with the reason in stderr. GIT_TERMINAL_PROMPT=0 keeps a credential
 * prompt from hanging an unattended process.
 */
export function runGit(args: string[], cwd: string, timeout = 15000): Promise<GitResult> {
  return new Promise((res) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
    }, timeout)

    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      res({ code: 1, stdout: '', stderr: err.message })
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (killed) {
        res({ code: 1, stdout, stderr: 'git command timed out' })
        return
      }
      res({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** Stdout of a git command that succeeded, or undefined when it did not. */
export async function gitStdout(
  args: string[],
  cwd: string,
  timeout?: number,
): Promise<string | undefined> {
  const result = await runGit(args, cwd, timeout)
  return result.code === 0 ? result.stdout : undefined
}
