import type { Tool, ToolResult } from '../../types'
import { apiError, type GitHubConfig, ghFetch, resolveHeadRef, resolveRepo } from './helpers'

export function createGhCiStatus(config: GitHubConfig): Tool {
  return {
    definition: {
      name: 'gh_ci_status',
      description:
        'Check CI/workflow status for a git ref (branch, tag, or commit SHA). Shows check runs and their conclusions.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Git ref to check (branch name, tag, or SHA). Defaults to HEAD branch.',
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
      const ref = (params.ref as string) || 'HEAD'

      // Resolve HEAD to actual branch name from local git
      let resolvedRef = ref
      if (ref === 'HEAD') {
        const detected = await resolveHeadRef(cwd)
        if (detected) resolvedRef = detected
      }

      // Get combined status (legacy status API)
      const [statusRes, checksRes] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/commits/${resolvedRef}/status`, config.token),
        ghFetch(
          `/repos/${owner}/${repo}/commits/${resolvedRef}/check-runs?per_page=50`,
          config.token,
        ),
      ])

      const parts: string[] = [`CI status for ${resolvedRef}:`]

      // Legacy commit statuses
      if (statusRes.status === 200) {
        const combined = statusRes.data as {
          state: string
          statuses: Array<{
            context: string
            state: string
            description: string | null
            target_url: string | null
          }>
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
            name: string
            status: string
            conclusion: string | null
            started_at: string | null
            completed_at: string | null
            html_url: string | null
          }>
        }

        if (checks.check_runs.length) {
          const completed = checks.check_runs.filter((c) => c.status === 'completed')
          const inProgress = checks.check_runs.filter((c) => c.status === 'in_progress')
          const queued = checks.check_runs.filter((c) => c.status === 'queued')

          parts.push(
            `\ncheck runs: ${checks.total_count} total (${completed.length} completed, ${inProgress.length} running, ${queued.length} queued)`,
          )

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
