/**
 * Deadline extensions for bounded task runs, granted on evidence rather than on the model's
 * word. A model that says "almost done" an hour in is as likely looping as finishing, so the
 * runner looks at what the run actually did since its start (or its last grant): distinct
 * successful tool calls, artifact actions (files written, commits made), and whether the
 * repeat detector tripped. Pure decision logic plus a small tracker; the tool lives in
 * ./task-controls.ts.
 */

/** Distinct successful (name, args) tool calls since the last checkpoint that count as progress. */
export const MIN_DISTINCT_CALLS = 3

/** Tools whose own calls never count as progress: asking for time is not doing work. */
const CONTROL_TOOLS = new Set(['request_extension', 'end_task'])

const ARTIFACT_TOOLS = new Set(['write_file', 'edit_file', 'git_commit'])
const GIT_ARTIFACT_COMMAND = /\bgit\b[^\n;&|]*?\b(commit|push)\b/

export interface ExtensionPolicy {
  /** The run's original wall-clock budget. */
  budgetMs: number
  maxExtensions: number
  /** Total extension may not exceed budgetMs × this. */
  maxExtensionRatio: number
}

export interface ProgressEvidence {
  /** Successful tool calls with distinct (name, args) since the last checkpoint. */
  distinctCalls: number
  /** write_file / edit_file / git_commit / a shell git commit or push, since the last checkpoint. */
  artifactActions: number
  /** Times the repeat detector flagged a call since the last checkpoint. */
  repeatTrips: number
}

export type ExtensionVerdict = 'granted' | 'no_progress' | 'repeating' | 'cap_reached' | 'invalid'

export interface ExtensionDecision {
  verdict: ExtensionVerdict
  /** Time actually granted (0 unless verdict is 'granted'). */
  grantedMs: number
  evidence: ProgressEvidence
  grantsSoFar: number
  /** Extension time still available after this decision. */
  remainingCapMs: number
}

/** An action that leaves a durable artifact behind — strong evidence of progress on its own. */
export function isArtifactAction(name: string, argsJson: string): boolean {
  if (ARTIFACT_TOOLS.has(name)) return true
  if (name !== 'execute_command') return false
  try {
    const args = JSON.parse(argsJson) as { command?: unknown }
    return typeof args.command === 'string' && GIT_ARTIFACT_COMMAND.test(args.command)
  } catch {
    return false
  }
}

/** Accumulates progress evidence for one run; `checkpoint()` starts a new window. */
export class ProgressTracker {
  private distinct = new Set<string>()
  private artifacts = 0
  private repeats = 0

  recordTool(name: string, argsJson: string, success: boolean): void {
    if (!success || CONTROL_TOOLS.has(name)) return
    this.distinct.add(`${name}:${argsJson}`)
    if (isArtifactAction(name, argsJson)) this.artifacts++
  }

  recordRepeat(): void {
    this.repeats++
  }

  snapshot(): ProgressEvidence {
    return {
      distinctCalls: this.distinct.size,
      artifactActions: this.artifacts,
      repeatTrips: this.repeats,
    }
  }

  checkpoint(): void {
    this.distinct.clear()
    this.artifacts = 0
    this.repeats = 0
  }
}

/**
 * Decide an extension request. Caps first (they are absolute), then the evidence: a repeat-
 * detector trip in the window denies outright; otherwise at least one artifact action, or at
 * least MIN_DISTINCT_CALLS distinct successful calls, earns up to the requested minutes,
 * clipped to what the total cap has left.
 */
export function decideExtension(input: {
  requestedMinutes: number
  evidence: ProgressEvidence
  grantsSoFar: number
  extendedMsSoFar: number
  policy: ExtensionPolicy
}): ExtensionDecision {
  const { requestedMinutes, evidence, grantsSoFar, extendedMsSoFar, policy } = input
  const capMs = Math.max(0, policy.budgetMs * policy.maxExtensionRatio)
  const remainingCapMs = Math.max(0, capMs - extendedMsSoFar)
  const base = { evidence, grantsSoFar, remainingCapMs, grantedMs: 0 }

  if (!Number.isFinite(requestedMinutes) || requestedMinutes <= 0) {
    return { ...base, verdict: 'invalid' }
  }
  if (grantsSoFar >= policy.maxExtensions || remainingCapMs <= 0) {
    return { ...base, verdict: 'cap_reached' }
  }
  if (evidence.repeatTrips > 0) return { ...base, verdict: 'repeating' }
  if (evidence.artifactActions < 1 && evidence.distinctCalls < MIN_DISTINCT_CALLS) {
    return { ...base, verdict: 'no_progress' }
  }

  const grantedMs = Math.min(Math.round(requestedMinutes * 60_000), remainingCapMs)
  return {
    verdict: 'granted',
    evidence,
    grantedMs,
    grantsSoFar: grantsSoFar + 1,
    remainingCapMs: remainingCapMs - grantedMs,
  }
}
