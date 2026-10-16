import { statSync } from 'node:fs'
import { resolveUserPath } from '../util/paths'

/**
 * Deliverable check: the files a task declares it must leave behind, verified on disk after
 * the run instead of taken from the reply.
 *
 * A reply that says "review written to ~/work/reviews/x.md" is a claim. A long run that loses
 * the thread near its end will still write that sentence. The runner stat()s each declared path:
 * it must exist, be non-empty, and have been written since `since` (so a file left from an
 * earlier run doesn't count).
 */

/** Filesystem mtime granularity and clock skew; a file written in the run's first second counts. */
const MTIME_SLACK_MS = 2000

export type DeliverableProblem = 'missing' | 'empty' | 'stale'

export interface DeliverableIssue {
  /** As declared on the task. */
  path: string
  /** Absolute path that was checked. */
  resolved: string
  problem: DeliverableProblem
}

/** The declared deliverables that are not on disk as required. Empty means all are fine. */
export function checkDeliverables(paths: string[], cwd: string, since: number): DeliverableIssue[] {
  const issues: DeliverableIssue[] = []
  for (const path of paths) {
    const resolved = resolveUserPath(path, cwd)
    let problem: DeliverableProblem | undefined
    try {
      const st = statSync(resolved)
      if (st.isFile() && st.size === 0) problem = 'empty'
      else if (st.mtimeMs < since - MTIME_SLACK_MS) problem = 'stale'
    } catch {
      problem = 'missing'
    }
    if (problem) issues.push({ path, resolved, problem })
  }
  return issues
}

function describe(issue: DeliverableIssue): string {
  const why =
    issue.problem === 'missing'
      ? 'does not exist'
      : issue.problem === 'empty'
        ? 'is empty'
        : 'was not written during this task (it predates it)'
  return `- ${issue.path} (${issue.resolved}) ${why}`
}

/** The corrective turn: what is missing, checked on disk, and what to do about it. */
export function deliverableNudge(issues: DeliverableIssue[]): string {
  return [
    '[Deliverable check: this task must leave these files behind, and the runner checked the disk:',
    ...issues.map(describe),
    'Write them now with your tools, then verify each exists (e.g. ls -la <path>). If you cannot produce one, say so plainly and why. Do not describe a file as written unless it is on disk.]',
  ].join('\n')
}

/** Prepended to a result whose deliverables are still missing after the corrective turn. */
export function deliverableNotice(issues: DeliverableIssue[]): string {
  return [
    '[Deliverable check FAILED: the runner checked the disk after the run; the reply below may say otherwise]',
    ...issues.map(describe),
  ].join('\n')
}
