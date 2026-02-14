import { spawn } from 'child_process'
import type { Tool, ToolResult } from '../types'

const API_BASE = 'https://api.github.com'
const MAX_OUTPUT = 20000

export interface GitHubConfig {
  token: string
  defaultOwner?: string
  defaultRepo?: string
}

// --- GitHub API helpers ---

async function ghFetch(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'egirl-agent/1.0',
    },
    ...(options.body && { body: JSON.stringify(options.body) }),
  })

  const data = await response.json()
  return { status: response.status, data }
}

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - max
  return text.slice(0, half) + `\n\n... (${omitted} characters omitted) ...\n\n` + text.slice(-half)
}

/**
 * Detect owner/repo from the git remote in the given directory.
 */
function detectRepo(cwd: string): Promise<{ owner: string; repo: string } | undefined> {
  return new Promise((res) => {
    const proc = spawn('git', ['remote', 'get-url', 'origin'], { cwd })
    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.on('error', () => res(undefined))
    proc.on('close', (code) => {
      if (code !== 0) { res(undefined); return }
      const url = stdout.trim()
      // Handle SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
      if (sshMatch) {
        res({ owner: sshMatch[1]!, repo: sshMatch[2]! })
        return
      }
      // Handle HTTPS: https://github.com/owner/repo.git
      const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
      if (httpsMatch) {
        res({ owner: httpsMatch[1]!, repo: httpsMatch[2]! })
        return
      }
      res(undefined)
    })
  })
}

async function resolveRepo(
  params: Record<string, unknown>,
  cwd: string,
  config: GitHubConfig,
): Promise<{ owner: string; repo: string } | string> {
  const owner = params.owner as string | undefined
  const repo = params.repo as string | undefined

  if (owner && repo) return { owner, repo }

  if (config.defaultOwner && config.defaultRepo) {
    return { owner: config.defaultOwner, repo: config.defaultRepo }
  }

  const detected = await detectRepo(cwd)
  if (detected) return detected

  return 'Could not determine repository. Provide owner and repo parameters, or run from a directory with a GitHub remote.'
}

function apiError(status: number, data: unknown): string {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    return `GitHub API error (${status}): ${(data as { message: string }).message}`
  }
  return `GitHub API error (${status})`
}

// --- PR Tools ---

function createGhPrList(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_list',
      description: 'List pull requests for a GitHub repository. Returns title, number, author, branch, and status.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Filter by PR state (default: open)',
          },
          head: {
            type: 'string',
            description: 'Filter by head branch (user:branch or branch)',
          },
          base: {
            type: 'string',
            description: 'Filter by base branch',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default: 10, max: 30)',
          },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: [],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const state = (params.state as string) || 'open'
      const limit = Math.min((params.limit as number) || 10, 30)
      const head = params.head as string | undefined
      const base = params.base as string | undefined

      const query = new URLSearchParams({ state, per_page: String(limit) })
      if (head) query.set('head', head.includes(':') ? head : `${owner}:${head}`)
      if (base) query.set('base', base)

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/pulls?${query}`, config.token)
      if (status !== 200) return { success: false, output: apiError(status, data) }

      const prs = data as Array<{
        number: number; title: string; state: string
        user: { login: string }; head: { ref: string }; base: { ref: string }
        draft: boolean; created_at: string; updated_at: string
      }>

      if (prs.length === 0) return { success: true, output: 'No pull requests found' }

      const lines = prs.map((pr) => {
        const draft = pr.draft ? ' [draft]' : ''
        return `#${pr.number} ${pr.title}${draft}\n  ${pr.head.ref} → ${pr.base.ref} | @${pr.user.login} | ${pr.state} | ${pr.updated_at.slice(0, 10)}`
      })

      return { success: true, output: lines.join('\n\n') }
    },
  }
}

function createGhPrView(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_view',
      description: 'View detailed information about a pull request: title, description, reviews, check status, and file changes.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number

      const [prRes, reviewsRes, filesRes] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/pulls/${num}`, config.token),
        ghFetch(`/repos/${owner}/${repo}/pulls/${num}/reviews`, config.token),
        ghFetch(`/repos/${owner}/${repo}/pulls/${num}/files?per_page=50`, config.token),
      ])

      if (prRes.status !== 200) return { success: false, output: apiError(prRes.status, prRes.data) }

      const pr = prRes.data as {
        number: number; title: string; state: string; draft: boolean
        body: string | null; user: { login: string }
        head: { ref: string; sha: string }; base: { ref: string }
        merged: boolean; mergeable: boolean | null; mergeable_state: string
        additions: number; deletions: number; changed_files: number
        created_at: string; updated_at: string
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        requested_reviewers: Array<{ login: string }>
      }

      const parts: string[] = []

      // Header
      const statusTag = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state
      parts.push(`#${pr.number} ${pr.title} [${statusTag}]`)
      parts.push(`${pr.head.ref} → ${pr.base.ref} | @${pr.user.login}`)

      if (pr.labels.length) parts.push(`labels: ${pr.labels.map(l => l.name).join(', ')}`)
      if (pr.assignees.length) parts.push(`assignees: ${pr.assignees.map(a => a.login).join(', ')}`)
      if (pr.requested_reviewers.length) parts.push(`reviewers requested: ${pr.requested_reviewers.map(r => r.login).join(', ')}`)

      parts.push(`+${pr.additions} -${pr.deletions} across ${pr.changed_files} files`)
      if (pr.mergeable !== null) parts.push(`mergeable: ${pr.mergeable} (${pr.mergeable_state})`)

      // Body
      if (pr.body?.trim()) {
        parts.push('\n--- description ---')
        parts.push(truncate(pr.body.trim(), 3000))
      }

      // Reviews
      if (reviewsRes.status === 200) {
        const reviews = reviewsRes.data as Array<{
          user: { login: string }; state: string; body: string | null; submitted_at: string
        }>
        const meaningful = reviews.filter(r => r.state !== 'PENDING')
        if (meaningful.length) {
          parts.push('\n--- reviews ---')
          for (const r of meaningful.slice(-10)) {
            const body = r.body?.trim() ? `: ${r.body.trim().slice(0, 200)}` : ''
            parts.push(`@${r.user.login} ${r.state}${body}`)
          }
        }
      }

      // Files
      if (filesRes.status === 200) {
        const files = filesRes.data as Array<{
          filename: string; status: string; additions: number; deletions: number
        }>
        if (files.length) {
          parts.push('\n--- files ---')
          for (const f of files) {
            parts.push(`${f.status.charAt(0).toUpperCase()} ${f.filename} (+${f.additions} -${f.deletions})`)
          }
        }
      }

      return { success: true, output: parts.join('\n') }
    },
  }
}

function createGhPrCreate(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_create',
      description: 'Create a new pull request. The head branch must already be pushed to the remote.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          head: { type: 'string', description: 'Head branch name (the branch with your changes)' },
          base: { type: 'string', description: 'Base branch to merge into (default: main)' },
          body: { type: 'string', description: 'PR description body' },
          draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['title', 'head'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/pulls`, config.token, {
        method: 'POST',
        body: {
          title: params.title as string,
          head: params.head as string,
          base: (params.base as string) || 'main',
          body: (params.body as string) || '',
          draft: (params.draft as boolean) || false,
        },
      })

      if (status !== 201) return { success: false, output: apiError(status, data) }

      const pr = data as { number: number; html_url: string; title: string }
      return { success: true, output: `Created PR #${pr.number}: ${pr.title}\n${pr.html_url}` }
    },
  }
}

function createGhPrReview(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_review',
      description: 'Submit a review on a pull request. Can approve, request changes, or leave a comment.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          event: {
            type: 'string',
            enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
            description: 'Review action',
          },
          body: { type: 'string', description: 'Review comment body (required for REQUEST_CHANGES and COMMENT)' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number', 'event'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number
      const event = params.event as string
      const body = params.body as string | undefined

      if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && !body?.trim()) {
        return { success: false, output: `Review body is required for ${event}` }
      }

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/pulls/${num}/reviews`, config.token, {
        method: 'POST',
        body: { event, body: body || '' },
      })

      if (status !== 200) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Review submitted: ${event} on PR #${num}` }
    },
  }
}

function createGhPrComment(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_comment',
      description: 'Add a comment to a pull request.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          body: { type: 'string', description: 'Comment text' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number', 'body'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number
      const body = params.body as string

      // PRs use the issues API for regular comments
      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/issues/${num}/comments`, config.token, {
        method: 'POST',
        body: { body },
      })

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Comment added to PR #${num}` }
    },
  }
}

// --- Issue Tools ---

function createGhIssueList(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_list',
      description: 'List issues for a GitHub repository. Returns title, number, author, labels, and status.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Filter by issue state (default: open)',
          },
          labels: {
            type: 'string',
            description: 'Comma-separated list of label names to filter by',
          },
          assignee: {
            type: 'string',
            description: 'Filter by assignee username',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'comments'],
            description: 'Sort field (default: updated)',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default: 10, max: 30)',
          },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: [],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const state = (params.state as string) || 'open'
      const limit = Math.min((params.limit as number) || 10, 30)
      const sort = (params.sort as string) || 'updated'
      const labels = params.labels as string | undefined
      const assignee = params.assignee as string | undefined

      const query = new URLSearchParams({
        state, sort, per_page: String(limit), direction: 'desc',
      })
      if (labels) query.set('labels', labels)
      if (assignee) query.set('assignee', assignee)

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/issues?${query}`, config.token)
      if (status !== 200) return { success: false, output: apiError(status, data) }

      const issues = (data as Array<{
        number: number; title: string; state: string
        user: { login: string }; labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        comments: number; created_at: string; updated_at: string
        pull_request?: unknown
      }>).filter(i => !i.pull_request) // Exclude PRs from issue list

      if (issues.length === 0) return { success: true, output: 'No issues found' }

      const lines = issues.map((i) => {
        const labelStr = i.labels.length ? ` [${i.labels.map(l => l.name).join(', ')}]` : ''
        const assigneeStr = i.assignees.length ? ` → ${i.assignees.map(a => a.login).join(', ')}` : ''
        return `#${i.number} ${i.title}${labelStr}\n  @${i.user.login}${assigneeStr} | ${i.comments} comments | ${i.updated_at.slice(0, 10)}`
      })

      return { success: true, output: lines.join('\n\n') }
    },
  }
}

function createGhIssueView(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_view',
      description: 'View detailed information about a GitHub issue, including its body and recent comments.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number

      const [issueRes, commentsRes] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/issues/${num}`, config.token),
        ghFetch(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=20`, config.token),
      ])

      if (issueRes.status !== 200) return { success: false, output: apiError(issueRes.status, issueRes.data) }

      const issue = issueRes.data as {
        number: number; title: string; state: string
        body: string | null; user: { login: string }
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        milestone: { title: string } | null
        comments: number; created_at: string; updated_at: string
      }

      const parts: string[] = []

      // Header
      parts.push(`#${issue.number} ${issue.title} [${issue.state}]`)
      parts.push(`@${issue.user.login} | created ${issue.created_at.slice(0, 10)} | updated ${issue.updated_at.slice(0, 10)}`)
      if (issue.labels.length) parts.push(`labels: ${issue.labels.map(l => l.name).join(', ')}`)
      if (issue.assignees.length) parts.push(`assignees: ${issue.assignees.map(a => a.login).join(', ')}`)
      if (issue.milestone) parts.push(`milestone: ${issue.milestone.title}`)

      // Body
      if (issue.body?.trim()) {
        parts.push('\n--- description ---')
        parts.push(truncate(issue.body.trim(), 3000))
      }

      // Comments
      if (commentsRes.status === 200) {
        const comments = commentsRes.data as Array<{
          user: { login: string }; body: string; created_at: string
        }>
        if (comments.length) {
          parts.push(`\n--- comments (${comments.length}${issue.comments > 20 ? ` of ${issue.comments}` : ''}) ---`)
          for (const c of comments) {
            parts.push(`@${c.user.login} (${c.created_at.slice(0, 10)}):\n${truncate(c.body.trim(), 500)}`)
          }
        }
      }

      return { success: true, output: parts.join('\n') }
    },
  }
}

function createGhIssueComment(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_comment',
      description: 'Add a comment to a GitHub issue.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number' },
          body: { type: 'string', description: 'Comment text' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number', 'body'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/issues/${num}/comments`, config.token, {
        method: 'POST',
        body: { body: params.body as string },
      })

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Comment added to issue #${num}` }
    },
  }
}

function createGhIssueUpdate(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_update',
      description: 'Update a GitHub issue: change state, labels, assignees, or title.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'Set issue state' },
          title: { type: 'string', description: 'New title' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace all labels with this list',
          },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace all assignees with this list',
          },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['number'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const num = params.number as number

      const body: Record<string, unknown> = {}
      if (params.state !== undefined) body.state = params.state
      if (params.title !== undefined) body.title = params.title
      if (params.labels !== undefined) body.labels = params.labels
      if (params.assignees !== undefined) body.assignees = params.assignees

      if (Object.keys(body).length === 0) {
        return { success: false, output: 'No updates specified. Provide at least one of: state, title, labels, assignees' }
      }

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/issues/${num}`, config.token, {
        method: 'PATCH',
        body,
      })

      if (status !== 200) return { success: false, output: apiError(status, data) }

      const issue = data as { number: number; title: string; state: string }
      return { success: true, output: `Updated issue #${issue.number}: ${issue.title} [${issue.state}]` }
    },
  }
}

// --- CI Status Tool ---

function createGhCiStatus(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_ci_status',
      description: 'Check CI/workflow status for a git ref (branch, tag, or commit SHA). Shows check runs and their conclusions.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Git ref to check (branch name, tag, or SHA). Defaults to HEAD branch.',
          },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: [],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const ref = (params.ref as string) || 'HEAD'

      // Resolve HEAD to actual branch name from local git
      let resolvedRef = ref
      if (ref === 'HEAD') {
        const detected = await new Promise<string | undefined>((res) => {
          const proc = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
          let out = ''
          proc.stdout.on('data', (d) => { out += d.toString() })
          proc.on('error', () => res(undefined))
          proc.on('close', (code) => res(code === 0 ? out.trim() : undefined))
        })
        if (detected) resolvedRef = detected
      }

      // Get combined status (legacy status API)
      const [statusRes, checksRes] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/commits/${resolvedRef}/status`, config.token),
        ghFetch(`/repos/${owner}/${repo}/commits/${resolvedRef}/check-runs?per_page=50`, config.token),
      ])

      const parts: string[] = [`CI status for ${resolvedRef}:`]

      // Legacy commit statuses
      if (statusRes.status === 200) {
        const combined = statusRes.data as {
          state: string
          statuses: Array<{ context: string; state: string; description: string | null; target_url: string | null }>
        }
        if (combined.statuses.length) {
          parts.push(`\ncommit status: ${combined.state}`)
          for (const s of combined.statuses) {
            const desc = s.description ? ` — ${s.description.slice(0, 80)}` : ''
            parts.push(`  ${s.state} ${s.context}${desc}`)
          }
        }
      }

      // Check runs (GitHub Actions, etc.)
      if (checksRes.status === 200) {
        const checks = checksRes.data as {
          total_count: number
          check_runs: Array<{
            name: string; status: string; conclusion: string | null
            started_at: string | null; completed_at: string | null
            html_url: string | null
          }>
        }

        if (checks.check_runs.length) {
          const completed = checks.check_runs.filter(c => c.status === 'completed')
          const inProgress = checks.check_runs.filter(c => c.status === 'in_progress')
          const queued = checks.check_runs.filter(c => c.status === 'queued')

          parts.push(`\ncheck runs: ${checks.total_count} total (${completed.length} completed, ${inProgress.length} running, ${queued.length} queued)`)

          for (const c of checks.check_runs) {
            const status = c.conclusion ?? c.status
            parts.push(`  ${status} ${c.name}`)
          }
        }
      }

      if (statusRes.status !== 200 && checksRes.status !== 200) {
        return { success: false, output: apiError(statusRes.status, statusRes.data) }
      }

      if (parts.length === 1) {
        parts.push('No CI checks found for this ref')
      }

      return { success: true, output: parts.join('\n') }
    },
  }
}

// --- Branch Management Tool ---

function createGhBranchCreate(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_branch_create',
      description: 'Create a new branch on the GitHub remote from a given ref (branch, tag, or SHA).',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Name for the new branch' },
          from: { type: 'string', description: 'Source ref to branch from (default: main)' },
          owner: { type: 'string', description: 'Repository owner (auto-detected from git remote)' },
          repo: { type: 'string', description: 'Repository name (auto-detected from git remote)' },
        },
        required: ['branch'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const resolved = await resolveRepo(params, cwd, config)
      if (typeof resolved === 'string') return { success: false, output: resolved }

      const { owner, repo } = resolved
      const branch = params.branch as string
      const from = (params.from as string) || 'main'

      // First resolve the source ref to a SHA
      const refRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${from}`, config.token)

      let sha: string
      if (refRes.status === 200) {
        sha = ((refRes.data as { object: { sha: string } }).object.sha)
      } else {
        // Try as a tag
        const tagRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/tags/${from}`, config.token)
        if (tagRes.status === 200) {
          sha = ((tagRes.data as { object: { sha: string } }).object.sha)
        } else {
          // Try as a raw SHA
          const commitRes = await ghFetch(`/repos/${owner}/${repo}/git/commits/${from}`, config.token)
          if (commitRes.status !== 200) {
            return { success: false, output: `Could not resolve ref '${from}': ${apiError(refRes.status, refRes.data)}` }
          }
          sha = (commitRes.data as { sha: string }).sha
        }
      }

      const { status, data } = await ghFetch(`/repos/${owner}/${repo}/git/refs`, config.token, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha },
      })

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Created branch '${branch}' from ${from} (${sha.slice(0, 7)})` }
    },
  }
}

// --- Factory ---

export function createGitHubTools(config: GitHubConfig): {
  ghPrListTool: Tool
  ghPrViewTool: Tool
  ghPrCreateTool: Tool
  ghPrReviewTool: Tool
  ghPrCommentTool: Tool
  ghIssueListTool: Tool
  ghIssueViewTool: Tool
  ghIssueCommentTool: Tool
  ghIssueUpdateTool: Tool
  ghCiStatusTool: Tool
  ghBranchCreateTool: Tool
} {
  return {
    ghPrListTool: createGhPrList(config),
    ghPrViewTool: createGhPrView(config),
    ghPrCreateTool: createGhPrCreate(config),
    ghPrReviewTool: createGhPrReview(config),
    ghPrCommentTool: createGhPrComment(config),
    ghIssueListTool: createGhIssueList(config),
    ghIssueViewTool: createGhIssueView(config),
    ghIssueCommentTool: createGhIssueComment(config),
    ghIssueUpdateTool: createGhIssueUpdate(config),
    ghCiStatusTool: createGhCiStatus(config),
    ghBranchCreateTool: createGhBranchCreate(config),
  }
}
