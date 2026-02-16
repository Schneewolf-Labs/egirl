import type { Tool, ToolResult } from '../../types'
import { apiError, type GitHubConfig, ghFetch, resolveRepo, truncate } from './helpers'

export function createGhPrList(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_list',
      description:
        'List pull requests for a GitHub repository. Returns title, number, author, branch, and status.',
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
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
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
        number: number
        title: string
        state: string
        user: { login: string }
        head: { ref: string }
        base: { ref: string }
        draft: boolean
        created_at: string
        updated_at: string
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

export function createGhPrView(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_view',
      description:
        'View detailed information about a pull request: title, description, reviews, check status, and file changes.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
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

      if (prRes.status !== 200)
        return { success: false, output: apiError(prRes.status, prRes.data) }

      const pr = prRes.data as {
        number: number
        title: string
        state: string
        draft: boolean
        body: string | null
        user: { login: string }
        head: { ref: string; sha: string }
        base: { ref: string }
        merged: boolean
        mergeable: boolean | null
        mergeable_state: string
        additions: number
        deletions: number
        changed_files: number
        created_at: string
        updated_at: string
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        requested_reviewers: Array<{ login: string }>
      }

      const parts: string[] = []

      // Header
      const statusTag = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state
      parts.push(`#${pr.number} ${pr.title} [${statusTag}]`)
      parts.push(`${pr.head.ref} → ${pr.base.ref} | @${pr.user.login}`)

      if (pr.labels.length) parts.push(`labels: ${pr.labels.map((l) => l.name).join(', ')}`)
      if (pr.assignees.length)
        parts.push(`assignees: ${pr.assignees.map((a) => a.login).join(', ')}`)
      if (pr.requested_reviewers.length)
        parts.push(`reviewers requested: ${pr.requested_reviewers.map((r) => r.login).join(', ')}`)

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
          user: { login: string }
          state: string
          body: string | null
          submitted_at: string
        }>
        const meaningful = reviews.filter((r) => r.state !== 'PENDING')
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
          filename: string
          status: string
          additions: number
          deletions: number
        }>
        if (files.length) {
          parts.push('\n--- files ---')
          for (const f of files) {
            parts.push(
              `${f.status.charAt(0).toUpperCase()} ${f.filename} (+${f.additions} -${f.deletions})`,
            )
          }
        }
      }

      return { success: true, output: parts.join('\n') }
    },
  }
}

export function createGhPrCreate(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_create',
      description:
        'Create a new pull request. The head branch must already be pushed to the remote.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          head: { type: 'string', description: 'Head branch name (the branch with your changes)' },
          base: { type: 'string', description: 'Base branch to merge into (default: main)' },
          body: { type: 'string', description: 'PR description body' },
          draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
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

export function createGhPrReview(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_review',
      description:
        'Submit a review on a pull request. Can approve, request changes, or leave a comment.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          event: {
            type: 'string',
            enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
            description: 'Review action',
          },
          body: {
            type: 'string',
            description: 'Review comment body (required for REQUEST_CHANGES and COMMENT)',
          },
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
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

      const { status, data } = await ghFetch(
        `/repos/${owner}/${repo}/pulls/${num}/reviews`,
        config.token,
        {
          method: 'POST',
          body: { event, body: body || '' },
        },
      )

      if (status !== 200) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Review submitted: ${event} on PR #${num}` }
    },
  }
}

export function createGhPrComment(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_pr_comment',
      description: 'Add a comment to a pull request.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR number' },
          body: { type: 'string', description: 'Comment text' },
          owner: {
            type: 'string',
            description: 'Repository owner (auto-detected from git remote)',
          },
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
      const { status, data } = await ghFetch(
        `/repos/${owner}/${repo}/issues/${num}/comments`,
        config.token,
        {
          method: 'POST',
          body: { body },
        },
      )

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Comment added to PR #${num}` }
    },
  }
}
