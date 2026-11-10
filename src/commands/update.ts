import { existsSync } from 'fs'
import { resolve } from 'path'
import { colors, DIM, RESET } from '../ui/theme'
import { gitStdout, runGit } from '../util/git'

/** Where the running egirl checkout lives: src/commands/update.ts -> repo root. */
const DEFAULT_REPO_DIR = resolve(import.meta.dir, '..', '..')

/** A release tag: `v` plus a plain semver. Pre-releases (`v1.1.0-rc.1`) are not releases. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

export interface UpdateDeps {
  repoDir?: string
  /** Runs `bun install`; resolves to whether it succeeded. Injected so tests can skip it. */
  install?: (repoDir: string) => Promise<boolean>
}

export interface UpdateOptions {
  /** Report what would change without touching the working tree. */
  checkOnly: boolean
  /** Follow the branch's upstream (main) instead of the latest release tag. */
  edge: boolean
}

/** What an update moves HEAD to: a commit-ish git understands, and what to call it. */
interface UpdateTarget {
  ref: string
  label: string
}

const USAGE = 'Usage: egirl update [--check] [--edge]'

export function parseUpdateArgs(args: string[]): UpdateOptions {
  const options: UpdateOptions = { checkOnly: false, edge: false }
  for (const arg of args) {
    if (arg === '--check' || arg === '-n') {
      options.checkOnly = true
      continue
    }
    if (arg === '--edge') {
      options.edge = true
      continue
    }
    throw new Error(`Unknown option: ${arg}\n${USAGE}`)
  }
  return options
}

/** The newest `vX.Y.Z` tag in a list of tag names, compared numerically. */
export function latestReleaseTag(tags: string[]): string | undefined {
  let best: { tag: string; parts: number[] } | undefined
  for (const tag of tags) {
    const match = RELEASE_TAG.exec(tag.trim())
    if (!match) continue
    const parts = match.slice(1).map(Number)
    if (!best || compareParts(parts, best.parts) > 0) best = { tag: tag.trim(), parts }
  }
  return best?.tag
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function bunInstall(repoDir: string): Promise<boolean> {
  const proc = Bun.spawn([process.execPath, 'install'], {
    cwd: repoDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return (await proc.exited) === 0
}

function fail(message: string): never {
  throw new Error(message)
}

async function fetchRemote(repoDir: string, remote: string, withTags: boolean): Promise<void> {
  const args = withTags ? ['fetch', '--quiet', '--tags', remote] : ['fetch', '--quiet', remote]
  const fetch = await runGit(args, repoDir, 60000)
  if (fetch.code !== 0) fail(`fetch failed: ${fetch.stderr.trim()}`)
}

/** --edge: the branch's upstream, as before releases existed. */
async function edgeTarget(repoDir: string, step: (m: string) => void): Promise<UpdateTarget> {
  const branch = (await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir))?.trim()
  if (!branch || branch === 'HEAD') fail('detached HEAD; check out a branch to use --edge')

  const upstream = (
    await gitStdout(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoDir)
  )?.trim()
  if (!upstream) fail(`branch ${branch} has no upstream to update from`)

  step(`fetching ${upstream}`)
  await fetchRemote(repoDir, upstream.split('/')[0] ?? 'origin', false)
  return { ref: '@{u}', label: upstream }
}

/**
 * Default: the newest release tag on the upstream remote (origin when the branch tracks
 * nothing). A detached HEAD is fine here; a checkout of an older tag updates the same way.
 */
async function releaseTarget(repoDir: string, step: (m: string) => void): Promise<UpdateTarget> {
  const upstream = (
    await gitStdout(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoDir)
  )?.trim()
  const remote = upstream?.split('/')[0] || 'origin'

  step(`fetching release tags from ${remote}`)
  await fetchRemote(repoDir, remote, true)

  const tags = (await gitStdout(['tag', '--list', 'v*'], repoDir)) ?? ''
  const tag = latestReleaseTag(tags.split('\n'))
  if (!tag) fail(`no release tags (vX.Y.Z) on ${remote}; use --edge to follow the branch instead`)
  return { ref: `refs/tags/${tag}^{commit}`, label: tag }
}

/**
 * Bring a git-cloned egirl checkout up to the latest release, or with --edge to its upstream
 * branch. Fast-forward only: a checkout with local commits or edits is the operator's problem,
 * not something to stash or merge around. Reinstalls dependencies only when the lockfile or
 * package.json actually moved.
 */
export async function runUpdate(args: string[], deps: UpdateDeps = {}): Promise<void> {
  const c = colors()
  const options = parseUpdateArgs(args)
  const repoDir = deps.repoDir ?? DEFAULT_REPO_DIR
  const install = deps.install ?? bunInstall
  const step = (message: string) => console.log(`  ${c.accent}·${RESET} ${message}`)

  console.log(`\n${c.secondary}egirl${RESET} ${DIM}Update${RESET}\n`)

  if (!existsSync(resolve(repoDir, '.git'))) {
    fail(`${repoDir} is not a git checkout; update it however you installed it`)
  }

  const dirty = (
    await gitStdout(['status', '--porcelain', '--untracked-files=no'], repoDir)
  )?.trim()
  if (dirty === undefined) fail('git status failed')
  if (dirty) fail('working tree has uncommitted changes; commit or stash them first')

  const target = options.edge ? await edgeTarget(repoDir, step) : await releaseTarget(repoDir, step)
  const { ref, label } = target

  const before = (await gitStdout(['rev-parse', '--short', 'HEAD'], repoDir))?.trim()
  const ahead = Number((await gitStdout(['rev-list', '--count', `${ref}..HEAD`], repoDir))?.trim())
  const behind = Number((await gitStdout(['rev-list', '--count', `HEAD..${ref}`], repoDir))?.trim())
  if (Number.isNaN(ahead) || Number.isNaN(behind)) fail(`could not compare HEAD to ${label}`)

  if (behind === 0) {
    const past = ahead > 0 ? `, ${ahead} commit(s) past ${label}` : ''
    console.log(`\n${c.success}already up to date${RESET} ${DIM}${before}${past}${RESET}`)
    return
  }
  if (ahead > 0) {
    fail(`HEAD has ${ahead} commit(s) not in ${label}; rebase, push or check out ${label} first`)
  }

  const incoming = (await gitStdout(['log', '--oneline', `HEAD..${ref}`], repoDir)) ?? ''
  step(`${behind} new commit(s) in ${label}`)
  for (const line of incoming.trim().split('\n')) console.log(`      ${DIM}${line}${RESET}`)

  if (options.checkOnly) {
    console.log(`\n${c.warning}update available${RESET} ${DIM}run without --check to apply${RESET}`)
    return
  }

  const merge = await runGit(['merge', '--ff-only', '--quiet', ref], repoDir)
  if (merge.code !== 0) fail(`fast-forward failed: ${merge.stderr.trim()}`)
  const after = (await gitStdout(['rev-parse', '--short', 'HEAD'], repoDir))?.trim()
  step(`${before} → ${after} (${label})`)

  const depsChanged = (
    await gitStdout(
      ['diff', '--name-only', `${before}..HEAD`, '--', 'package.json', 'bun.lock'],
      repoDir,
    )
  )?.trim()
  if (depsChanged) {
    step('dependencies changed, running bun install')
    if (!(await install(repoDir))) fail('bun install failed; run it by hand')
  } else {
    step('dependencies unchanged')
  }

  console.log(
    `\n${c.success}updated${RESET} ${DIM}restart any running egirl processes to pick it up${RESET}`,
  )
}
