import { spawn } from 'child_process'

/**
 * Run a git command and return stdout, or undefined on failure.
 */
function runGit(args: string[], cwd: string, timeout = 10000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = ''
    let killed = false

    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
    }, timeout)

    proc.stdout.on('data', (d) => { stdout += d.toString() })

    proc.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (killed || code !== 0) {
        resolve(undefined)
        return
      }
      resolve(stdout)
    })
  })
}

export interface GitBranchInfo {
  current: string
  tracking: string | undefined
  ahead: number
  behind: number
}

export async function gatherBranch(cwd: string): Promise<GitBranchInfo | undefined> {
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (!branch) return undefined

  const current = branch.trim()

  // Get tracking branch info
  const tracking = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd
  )

  let ahead = 0
  let behind = 0

  if (tracking) {
    const counts = await runGit(
      ['rev-list', '--left-right', '--count', `HEAD...${tracking.trim()}`],
      cwd
    )
    if (counts) {
      const parts = counts.trim().split(/\s+/)
      ahead = parseInt(parts[0] ?? '0', 10) || 0
      behind = parseInt(parts[1] ?? '0', 10) || 0
    }
  }

  return {
    current,
    tracking: tracking?.trim(),
    ahead,
    behind,
  }
}

export interface FileStatus {
  staged: string[]
  modified: string[]
  untracked: string[]
}

export async function gatherStatus(cwd: string): Promise<FileStatus | undefined> {
  const output = await runGit(['status', '--porcelain=v1'], cwd)
  if (output === undefined) return undefined

  const staged: string[] = []
  const modified: string[] = []
  const untracked: string[] = []

  for (const line of output.split('\n')) {
    if (!line) continue
    const index = line[0]
    const worktree = line[1]
    const file = line.slice(3)

    if (index === '?' && worktree === '?') {
      untracked.push(file)
    } else {
      if (index !== ' ' && index !== '?') staged.push(file)
      if (worktree !== ' ' && worktree !== '?') modified.push(file)
    }
  }

  return { staged, modified, untracked }
}

export interface RecentCommit {
  hash: string
  date: string
  message: string
}

export async function gatherRecentCommits(cwd: string, count = 10): Promise<RecentCommit[]> {
  const output = await runGit(
    ['log', `--format=%h\t%ad\t%s`, '--date=short', `-n${count}`],
    cwd
  )
  if (!output) return []

  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, date, ...rest] = line.split('\t')
    return { hash: hash ?? '', date: date ?? '', message: rest.join('\t') }
  })
}

export async function gatherStashCount(cwd: string): Promise<number> {
  const output = await runGit(['stash', 'list'], cwd)
  if (!output?.trim()) return 0
  return output.trim().split('\n').length
}

export async function gatherLastCommitAge(cwd: string): Promise<string | undefined> {
  const output = await runGit(['log', '-1', '--format=%ar'], cwd)
  return output?.trim() || undefined
}

export function isGitRepo(cwd: string): Promise<boolean> {
  return runGit(['rev-parse', '--git-dir'], cwd).then((r) => r !== undefined)
}
