import {
  gatherBranch,
  gatherStatus,
  gatherRecentCommits,
  gatherStashCount,
  gatherLastCommitAge,
  isGitRepo,
} from './gather'
import { log } from '../util/logger'

export interface StandupReport {
  /** Formatted context string for injection into agent system prompt */
  context: string
  /** Whether the workspace is a git repo at all */
  isGitRepo: boolean
}

/**
 * Gather workspace state and produce a standup report.
 * Runs git commands against the workspace directory, collects branch info,
 * recent commits, working tree status, and stashes.
 *
 * Returns a formatted string suitable for injection into the agent's
 * system prompt as additionalContext.
 */
export async function gatherStandup(workspaceDir: string): Promise<StandupReport> {
  const hasGit = await isGitRepo(workspaceDir)
  if (!hasGit) {
    return { context: '', isGitRepo: false }
  }

  const [branch, status, commits, stashCount, lastActivity] = await Promise.all([
    gatherBranch(workspaceDir),
    gatherStatus(workspaceDir),
    gatherRecentCommits(workspaceDir),
    gatherStashCount(workspaceDir),
    gatherLastCommitAge(workspaceDir),
  ])

  const sections: string[] = ['## Workspace Standup']

  // Branch info
  if (branch) {
    let branchLine = `**Branch:** \`${branch.current}\``
    if (branch.tracking) {
      const parts: string[] = []
      if (branch.ahead > 0) parts.push(`${branch.ahead} ahead`)
      if (branch.behind > 0) parts.push(`${branch.behind} behind`)
      if (parts.length > 0) {
        branchLine += ` (${parts.join(', ')} of \`${branch.tracking}\`)`
      } else {
        branchLine += ` (tracking \`${branch.tracking}\`, up to date)`
      }
    } else {
      branchLine += ' (no upstream)'
    }
    sections.push(branchLine)
  }

  // Last activity
  if (lastActivity) {
    sections.push(`**Last commit:** ${lastActivity}`)
  }

  // Working tree status
  if (status) {
    const { staged, modified, untracked } = status
    const isClean = staged.length === 0 && modified.length === 0 && untracked.length === 0

    if (isClean) {
      sections.push('**Working tree:** clean')
    } else {
      const parts: string[] = []
      if (staged.length > 0) parts.push(`${staged.length} staged`)
      if (modified.length > 0) parts.push(`${modified.length} modified`)
      if (untracked.length > 0) parts.push(`${untracked.length} untracked`)
      sections.push(`**Working tree:** ${parts.join(', ')}`)

      // List files if not too many
      const totalFiles = staged.length + modified.length + untracked.length
      if (totalFiles <= 20) {
        const fileLines: string[] = []
        for (const f of staged) fileLines.push(`  + ${f} (staged)`)
        for (const f of modified) fileLines.push(`  M ${f}`)
        for (const f of untracked) fileLines.push(`  ? ${f}`)
        sections.push('```\n' + fileLines.join('\n') + '\n```')
      }
    }
  }

  // Stashes
  if (stashCount > 0) {
    sections.push(`**Stashes:** ${stashCount}`)
  }

  // Recent commits
  if (commits.length > 0) {
    const commitLines = commits.map((c) => `- \`${c.hash}\` ${c.message} (${c.date})`)
    sections.push(`**Recent commits:**\n${commitLines.join('\n')}`)
  }

  const context = sections.join('\n\n')
  log.debug('standup', `Gathered standup: ${context.length} chars`)

  return { context, isGitRepo: true }
}
