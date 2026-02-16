import type { Tool, ToolResult } from '../../types'
import { apiError, type GitHubConfig, ghFetch, resolveRepo, truncate } from './helpers'

export function createGhIssueList(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_list',
      description:
        'List issues for a GitHub repository. Returns title, number, author, labels, and status.',
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
      const sort = (params.sort as string) || 'updated'
      const labels = params.labels as string | undefined
      const assignee = params.assignee as string | undefined

      const query = new URLSearchParams({
        state,
        sort,
        per_page: String(limit),
        direction: 'desc',
      })
      if (labels) query.set('labels', labels)
      if (assignee) query.set('assignee', assignee)

      const { status, data } = await ghFetch(
        `/repos/${owner}/${repo}/issues?${query}`,
        config.token,
      )
      if (status !== 200) return { success: false, output: apiError(status, data) }

      const issues = (
        data as Array<{
          number: number
          title: string
          state: string
          user: { login: string }
          labels: Array<{ name: string }>
          assignees: Array<{ login: string }>
          comments: number
          created_at: string
          updated_at: string
          pull_request?: unknown
        }>
      ).filter((i) => !i.pull_request) // Exclude PRs from issue list

      if (issues.length === 0) return { success: true, output: 'No issues found' }

      const lines = issues.map((i) => {
        const labelStr = i.labels.length ? ` [${i.labels.map((l) => l.name).join(', ')}]` : ''
        const assigneeStr = i.assignees.length
          ? ` → ${i.assignees.map((a) => a.login).join(', ')}`
          : ''
        return `#${i.number} ${i.title}${labelStr}\n  @${i.user.login}${assigneeStr} | ${i.comments} comments | ${i.updated_at.slice(0, 10)}`
      })

      return { success: true, output: lines.join('\n\n') }
    },
  }
}

export function createGhIssueView(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_view',
      description:
        'View detailed information about a GitHub issue, including its body and recent comments.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number' },
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

      const [issueRes, commentsRes] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/issues/${num}`, config.token),
        ghFetch(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=20`, config.token),
      ])

      if (issueRes.status !== 200)
        return { success: false, output: apiError(issueRes.status, issueRes.data) }

      const issue = issueRes.data as {
        number: number
        title: string
        state: string
        body: string | null
        user: { login: string }
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        milestone: { title: string } | null
        comments: number
        created_at: string
        updated_at: string
      }

      const parts: string[] = []

      // Header
      parts.push(`#${issue.number} ${issue.title} [${issue.state}]`)
      parts.push(
        `@${issue.user.login} | created ${issue.created_at.slice(0, 10)} | updated ${issue.updated_at.slice(0, 10)}`,
      )
      if (issue.labels.length) parts.push(`labels: ${issue.labels.map((l) => l.name).join(', ')}`)
      if (issue.assignees.length)
        parts.push(`assignees: ${issue.assignees.map((a) => a.login).join(', ')}`)
      if (issue.milestone) parts.push(`milestone: ${issue.milestone.title}`)

      // Body
      if (issue.body?.trim()) {
        parts.push('\n--- description ---')
        parts.push(truncate(issue.body.trim(), 3000))
      }

      // Comments
      if (commentsRes.status === 200) {
        const comments = commentsRes.data as Array<{
          user: { login: string }
          body: string
          created_at: string
        }>
        if (comments.length) {
          parts.push(
            `\n--- comments (${comments.length}${issue.comments > 20 ? ` of ${issue.comments}` : ''}) ---`,
          )
          for (const c of comments) {
            parts.push(
              `@${c.user.login} (${c.created_at.slice(0, 10)}):\n${truncate(c.body.trim(), 500)}`,
            )
          }
        }
      }

      return { success: true, output: parts.join('\n') }
    },
  }
}

export function createGhIssueComment(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_issue_comment',
      description: 'Add a comment to a GitHub issue.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number' },
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

      const { status, data } = await ghFetch(
        `/repos/${owner}/${repo}/issues/${num}/comments`,
        config.token,
        {
          method: 'POST',
          body: { body: params.body as string },
        },
      )

      if (status !== 201) return { success: false, output: apiError(status, data) }

      return { success: true, output: `Comment added to issue #${num}` }
    },
  }
}

export function createGhIssueUpdate(config: GitHubConfig): Tool {
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

      const body: Record<string, unknown> = {}
      if (params.state !== undefined) body.state = params.state
      if (params.title !== undefined) body.title = params.title
      if (params.labels !== undefined) body.labels = params.labels
      if (params.assignees !== undefined) body.assignees = params.assignees

      if (Object.keys(body).length === 0) {
        return {
          success: false,
          output: 'No updates specified. Provide at least one of: state, title, labels, assignees',
        }
      }

      const { status, data } = await ghFetch(
        `/repos/${owner}/${repo}/issues/${num}`,
        config.token,
        {
          method: 'PATCH',
          body,
        },
      )

      if (status !== 200) return { success: false, output: apiError(status, data) }

      const issue = data as { number: number; title: string; state: string }
      return {
        success: true,
        output: `Updated issue #${issue.number}: ${issue.title} [${issue.state}]`,
      }
    },
  }
}
