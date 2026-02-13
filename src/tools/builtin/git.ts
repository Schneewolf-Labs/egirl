import { spawn } from 'child_process'
import { resolve, isAbsolute } from 'path'
import type { Tool, ToolResult } from '../types'

const MAX_OUTPUT = 20000

function runGit(args: string[], cwd: string, timeout = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
    }, timeout)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

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

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - max
  return text.slice(0, half) + `\n\n... (${omitted} characters omitted) ...\n\n` + text.slice(-half)
}

function resolveCwd(dir: string | undefined, cwd: string): string {
  if (!dir) return cwd
  return isAbsolute(dir) ? dir : resolve(cwd, dir)
}

// --- git_status ---

export const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Show the current git repository state: branch name, staged changes, unstaged changes, and untracked files. Output is compact and structured for easy parsing.',
    parameters: {
      type: 'object',
      properties: {
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: [],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = resolveCwd(params.repo_dir as string | undefined, cwd)

    const [branch, status] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
      runGit(['status', '--porcelain=v1', '-b'], dir),
    ])

    if (branch.code !== 0 && branch.stderr.includes('not a git repository')) {
      return { success: false, output: 'Not a git repository' }
    }

    const branchName = branch.stdout.trim()
    const lines = status.stdout.trim().split('\n').filter(Boolean)

    // First line from -b is the branch header, skip it
    const fileLines = lines.slice(1)

    const staged: string[] = []
    const modified: string[] = []
    const untracked: string[] = []

    for (const line of fileLines) {
      const index = line[0]
      const worktree = line[1]
      const file = line.slice(3)

      if (index === '?' && worktree === '?') {
        untracked.push(file)
      } else {
        if (index !== ' ' && index !== '?') staged.push(`${index} ${file}`)
        if (worktree !== ' ' && worktree !== '?') modified.push(`${worktree} ${file}`)
      }
    }

    const parts = [`branch: ${branchName}`]
    if (staged.length) parts.push(`staged (${staged.length}):\n${staged.join('\n')}`)
    if (modified.length) parts.push(`modified (${modified.length}):\n${modified.join('\n')}`)
    if (untracked.length) parts.push(`untracked (${untracked.length}):\n${untracked.join('\n')}`)
    if (!staged.length && !modified.length && !untracked.length) parts.push('clean working tree')

    return { success: true, output: parts.join('\n\n') }
  },
}

// --- git_diff ---

export const gitDiffTool: Tool = {
  definition: {
    name: 'git_diff',
    description: 'Show git diff output. Can show staged changes, unstaged changes, or diff between references. Large diffs are truncated to protect context window.',
    parameters: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: 'Show staged (cached) changes instead of unstaged (default: false)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit diff to specific file paths',
        },
        ref: {
          type: 'string',
          description: 'Diff against a specific ref (branch, tag, commit hash). Overrides staged flag.',
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines around changes (default: 3)',
        },
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: [],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = resolveCwd(params.repo_dir as string | undefined, cwd)
    const staged = params.staged as boolean | undefined
    const files = params.files as string[] | undefined
    const ref = params.ref as string | undefined
    const contextLines = params.context_lines as number | undefined

    const args = ['diff', '--stat']

    if (contextLines !== undefined) args.push(`-U${contextLines}`)

    if (ref) {
      args.push(ref)
    } else if (staged) {
      args.push('--cached')
    }

    if (files?.length) {
      args.push('--')
      args.push(...files)
    }

    // Get stat summary first
    const stat = await runGit(args, dir)
    if (stat.code !== 0) {
      return { success: false, output: stat.stderr || 'git diff failed' }
    }

    // Now get the actual patch
    const patchArgs = args.filter(a => a !== '--stat')
    const patch = await runGit(patchArgs, dir)

    if (!patch.stdout.trim() && !stat.stdout.trim()) {
      return { success: true, output: 'No differences found' }
    }

    const output = stat.stdout.trim() + '\n\n' + truncate(patch.stdout.trim())
    return { success: true, output }
  },
}

// --- git_log ---

export const gitLogTool: Tool = {
  definition: {
    name: 'git_log',
    description: 'Show recent commit history in a compact format. Each entry shows hash, author, date, and message.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of commits to show (default: 10, max: 50)',
        },
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit to show history for (default: HEAD)',
        },
        file: {
          type: 'string',
          description: 'Show only commits that touch this file path',
        },
        oneline: {
          type: 'boolean',
          description: 'Ultra-compact one-line-per-commit format (default: false)',
        },
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: [],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = resolveCwd(params.repo_dir as string | undefined, cwd)
    const count = Math.min((params.count as number) || 10, 50)
    const ref = (params.ref as string) || 'HEAD'
    const file = params.file as string | undefined
    const oneline = params.oneline as boolean | undefined

    const format = oneline
      ? '--format=%h %s'
      : '--format=%h %an %ad %s'

    const args = ['log', format, `--date=short`, `-n${count}`, ref]

    if (file) {
      args.push('--', file)
    }

    const result = await runGit(args, dir)
    if (result.code !== 0) {
      return { success: false, output: result.stderr || 'git log failed' }
    }

    return { success: true, output: result.stdout.trim() || 'No commits found' }
  },
}

// --- git_commit ---

export const gitCommitTool: Tool = {
  definition: {
    name: 'git_commit',
    description: 'Stage files and create a git commit. If no files are specified, commits whatever is already staged. Does NOT push.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage before committing. Use ["."] to stage everything.',
        },
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: ['message'],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = resolveCwd(params.repo_dir as string | undefined, cwd)
    const message = params.message as string
    const files = params.files as string[] | undefined

    if (!message.trim()) {
      return { success: false, output: 'Commit message cannot be empty' }
    }

    // Stage files if specified
    if (files?.length) {
      const add = await runGit(['add', ...files], dir)
      if (add.code !== 0) {
        return { success: false, output: `Failed to stage files: ${add.stderr}` }
      }
    }

    // Check there's something to commit
    const check = await runGit(['diff', '--cached', '--quiet'], dir)
    if (check.code === 0) {
      return { success: false, output: 'Nothing staged to commit' }
    }

    const commit = await runGit(['commit', '-m', message], dir)
    if (commit.code !== 0) {
      return { success: false, output: `Commit failed: ${commit.stderr || commit.stdout}` }
    }

    // Return the new commit info
    const info = await runGit(['log', '-1', '--format=%h %s'], dir)
    return { success: true, output: info.stdout.trim() }
  },
}

// --- git_show ---

export const gitShowTool: Tool = {
  definition: {
    name: 'git_show',
    description: 'Show the contents of a specific commit: message, author, date, and diff. Large diffs are truncated.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Commit hash, branch, or tag to show (default: HEAD)',
        },
        file: {
          type: 'string',
          description: 'Show only changes to this file in the commit',
        },
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: [],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = resolveCwd(params.repo_dir as string | undefined, cwd)
    const ref = (params.ref as string) || 'HEAD'
    const file = params.file as string | undefined

    const args = ['show', '--stat', '--format=%H%n%an <%ae>%n%ad%n%n%B', '--date=short', ref]
    if (file) args.push('--', file)

    const stat = await runGit(args, dir)
    if (stat.code !== 0) {
      return { success: false, output: stat.stderr || 'git show failed' }
    }

    // Also get the patch
    const patchArgs = ['show', '--format=', '--patch', ref]
    if (file) patchArgs.push('--', file)

    const patch = await runGit(patchArgs, dir)

    const output = stat.stdout.trim() + (patch.stdout.trim() ? '\n\n' + truncate(patch.stdout.trim()) : '')
    return { success: true, output }
  },
}
