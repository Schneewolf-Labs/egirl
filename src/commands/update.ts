import { existsSync } from 'fs'
import { resolve } from 'path'
import { colors, DIM, RESET } from '../ui/theme'
import { gitStdout, runGit } from '../util/git'

/** Where the running egirl checkout lives: src/commands/update.ts -> repo root. */
const DEFAULT_REPO_DIR = resolve(import.meta.dir, '..', '..')

export interface UpdateDeps {
  repoDir?: string
  /** Runs `bun install`; resolves to whether it succeeded. Injected so tests can skip it. */
  install?: (repoDir: string) => Promise<boolean>
}

export interface UpdateOptions {
  /** Report what would change without touching the working tree. */
  checkOnly: boolean
}

export function parseUpdateArgs(args: string[]): UpdateOptions {
  const options: UpdateOptions = { checkOnly: false }
  for (const arg of args) {
    if (arg === '--check' || arg === '-n') {
      options.checkOnly = true
      continue
    }
    throw new Error(`Unknown option: ${arg}\nUsage: egirl update [--check]`)
  }
  return options
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

/**
 * Bring a git-cloned egirl checkout up to its upstream branch. Fast-forward only: a checkout
 * with local commits or edits is the operator's problem, not something to stash or merge
 * around. Reinstalls dependencies only when the lockfile or package.json actually moved.
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

  const branch = (await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir))?.trim()
  if (!branch || branch === 'HEAD') fail('detached HEAD; check out a branch first')

  const upstream = (
    await gitStdout(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoDir)
  )?.trim()
  if (!upstream) fail(`branch ${branch} has no upstream to update from`)

  const dirty = (
    await gitStdout(['status', '--porcelain', '--untracked-files=no'], repoDir)
  )?.trim()
  if (dirty === undefined) fail('git status failed')
  if (dirty) fail('working tree has uncommitted changes; commit or stash them first')

  step(`fetching ${upstream}`)
  const fetch = await runGit(
    ['fetch', '--quiet', upstream.split('/')[0] ?? 'origin'],
    repoDir,
    60000,
  )
  if (fetch.code !== 0) fail(`fetch failed: ${fetch.stderr.trim()}`)

  const before = (await gitStdout(['rev-parse', '--short', 'HEAD'], repoDir))?.trim()
  const ahead = Number((await gitStdout(['rev-list', '--count', '@{u}..HEAD'], repoDir))?.trim())
  const behind = Number((await gitStdout(['rev-list', '--count', 'HEAD..@{u}'], repoDir))?.trim())
  if (Number.isNaN(ahead) || Number.isNaN(behind)) fail('could not compare HEAD to upstream')

  if (behind === 0) {
    console.log(`\n${c.success}already up to date${RESET} ${DIM}${branch} @ ${before}${RESET}`)
    return
  }
  if (ahead > 0) {
    fail(`${branch} has ${ahead} local commit(s) not on ${upstream}; rebase or push them first`)
  }

  const incoming = (await gitStdout(['log', '--oneline', 'HEAD..@{u}'], repoDir)) ?? ''
  step(`${behind} new commit(s) on ${upstream}`)
  for (const line of incoming.trim().split('\n')) console.log(`      ${DIM}${line}${RESET}`)

  if (options.checkOnly) {
    console.log(`\n${c.warning}update available${RESET} ${DIM}run without --check to apply${RESET}`)
    return
  }

  const merge = await runGit(['merge', '--ff-only', '--quiet', '@{u}'], repoDir)
  if (merge.code !== 0) fail(`fast-forward failed: ${merge.stderr.trim()}`)
  const after = (await gitStdout(['rev-parse', '--short', 'HEAD'], repoDir))?.trim()
  step(`${before} → ${after}`)

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
