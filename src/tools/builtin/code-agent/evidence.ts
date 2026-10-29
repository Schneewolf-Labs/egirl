import { gitStdout } from '../../../util/git'
import { execTool } from '../exec'
import { boundLines } from './timeout-report'

/**
 * Disk evidence for a finished code agent run: what git says changed, set next to what the agent
 * says it did. The agent's final message is a claim; a run that lost the thread will still end
 * with "done, tests pass". The operator gets both and compares them, instead of taking the
 * summary on trust.
 *
 * A baseline is taken before the run so the result names this run's changes: commits made since,
 * the tree diffed against the starting commit (which counts work the agent committed, not only
 * what it left uncommitted), and untracked files that are new. Never throws: missing evidence
 * must not turn a finished run into a failure.
 */

const GIT_TIMEOUT_MS = 3000
/** A test suite gets far longer than an ad-hoc execute_command. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000
/** Failures print at the end; the tail is what the operator needs. */
const VERIFY_TAIL_CHARS = 2000

export interface GitBaseline {
  /** Commit checked out at the start; undefined on an unborn branch. */
  head?: string
  /** `git status --porcelain` lines at the start. */
  status: string[]
  /** Hash of `git diff <head>` at the start, to tell an untouched tree from a further-edited one. */
  diffHash?: string
}

function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n').filter((line) => line.trim())
}

function hash(text: string | undefined): string | undefined {
  return text === undefined ? undefined : Bun.hash(text).toString(16)
}

/** Undefined when the dir is not a git work tree or git is unavailable. */
export async function captureGitBaseline(workingDir: string): Promise<GitBaseline | undefined> {
  try {
    const inside = await gitStdout(
      ['rev-parse', '--is-inside-work-tree'],
      workingDir,
      GIT_TIMEOUT_MS,
    )
    if (inside?.trim() !== 'true') return undefined
    const head = (await gitStdout(['rev-parse', 'HEAD'], workingDir, GIT_TIMEOUT_MS))?.trim()
    const [status, diff] = await Promise.all([
      gitStdout(['status', '--porcelain'], workingDir, GIT_TIMEOUT_MS),
      head ? gitStdout(['diff', head], workingDir, GIT_TIMEOUT_MS) : undefined,
    ])
    return { ...(head && { head }), status: lines(status), diffHash: hash(diff) }
  } catch {
    return undefined
  }
}

/** The evidence block appended to a finished run's result. */
export async function gitEvidence(
  workingDir: string,
  baseline: GitBaseline | undefined,
): Promise<string> {
  const header = `[On disk, checked by egirl after the run in ${workingDir}`
  if (!baseline) return `${header}: not a git work tree, so its changes were not checked.]`

  try {
    const { head } = baseline
    const [nowHead, status, diff, stat, log] = await Promise.all([
      gitStdout(['rev-parse', 'HEAD'], workingDir, GIT_TIMEOUT_MS),
      gitStdout(['status', '--porcelain'], workingDir, GIT_TIMEOUT_MS),
      head ? gitStdout(['diff', head], workingDir, GIT_TIMEOUT_MS) : undefined,
      head ? gitStdout(['diff', '--stat', head], workingDir, GIT_TIMEOUT_MS) : undefined,
      head
        ? gitStdout(['log', '--oneline', `${head}..HEAD`], workingDir, GIT_TIMEOUT_MS)
        : undefined,
    ])
    if (status === undefined)
      return `${header}: git status failed, so its changes were not checked.]`

    const before = new Set(baseline.status)
    const added = lines(status).filter((line) => line.startsWith('??') && !before.has(line))
    const moved = nowHead?.trim() !== head
    const statusChanged = lines(status).join('\n') !== baseline.status.join('\n')
    const treeChanged = hash(diff) !== baseline.diffHash

    if (!moved && !statusChanged && !treeChanged) {
      return `${header}: nothing changed since the run started. No commits, and the working tree is as it was.]`
    }

    const parts = [`${header}:`]
    if (log?.trim()) parts.push(`Commits since the run started:\n${boundLines(log)}`)
    else if (moved)
      parts.push(
        `HEAD moved from ${head?.slice(0, 12) ?? '(unborn)'} to ${nowHead?.trim().slice(0, 12)}.`,
      )
    if (stat?.trim())
      parts.push(`Changed since the run started (git diff --stat):\n${boundLines(stat)}`)
    if (head && added.length) parts.push(`New untracked files:\n${boundLines(added.join('\n'))}`)
    if (!head) parts.push(`Working tree (git status --short):\n${boundLines(status)}`)
    if (parts.length === 1) parts.push('The tree changed, but git could not summarize how.')
    const dirty = baseline.status.filter((line) => !line.startsWith('??')).length
    if (head && dirty) {
      parts.push(
        `Note: ${dirty} tracked path(s) already had uncommitted changes before the run; ` +
          'they show in the diff above whether or not the agent touched them.',
      )
    }
    return `${parts.join('\n\n')}]`
  } catch {
    return `${header}: git failed, so its changes were not checked.]`
  }
}

export interface VerifyResult {
  passed: boolean
  report: string
}

/**
 * Run the operator's check command (`verify`) in the working dir after the agent finishes. The
 * exit code is the evidence; the agent's "tests pass" is not. Runs through execute_command's
 * spawn, so a hung suite is killed the same way.
 */
export async function runVerify(
  command: string,
  workingDir: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  const result = await execTool.execute(
    { command, working_dir: workingDir, timeout: timeoutMs },
    workingDir,
  )
  const output = result.output.trimEnd()
  const tail = output.length > VERIFY_TAIL_CHARS ? `…${output.slice(-VERIFY_TAIL_CHARS)}` : output
  const verdict = result.success ? 'passed' : 'FAILED'
  return {
    passed: result.success,
    report: `[Check run by egirl after the agent: \`${command}\` ${verdict}]\n${tail}`,
  }
}
