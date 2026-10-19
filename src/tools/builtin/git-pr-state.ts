import { lstat, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStdout, runGit } from '../../util/git'
import { resolveUserPath } from '../../util/paths'
import type { Tool, ToolResult } from '../types'

/**
 * git_pr_state: where a branch stands against main, from git itself.
 *
 * Reviewing a PR "against current main" mostly fails on the git part, not the code: models read
 * two-dot diffs as the PR reverting main's newer code, review against a stale merge base,
 * misread `git merge-tree` output, run the tests on main, or say "merges cleanly" without trying.
 * This does the bookkeeping once and reports facts: merge base and how far each side moved,
 * the PR's commits (and which are already on main as equivalent patches), the files both sides
 * touched with main's commits on them, and a real trial merge in a throwaway worktree, which
 * can be kept so tests run on the merged result.
 */

const LIST_MAX = 15
const MAIN_COMMITS_PER_FILE = 3
const SLOW_GIT_MS = 120_000
/** Untracked dependency dirs linked into a kept worktree so its tests can run without a reinstall. */
const DEP_DIRS = ['node_modules', '.venv', 'venv']

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

async function linkDeps(repoTop: string, wt: string): Promise<string[]> {
  const linked: string[] = []
  for (const d of DEP_DIRS) {
    if ((await exists(join(repoTop, d))) && !(await exists(join(wt, d)))) {
      await symlink(join(repoTop, d), join(wt, d)).then(
        () => linked.push(d),
        () => {},
      )
    }
  }
  return linked
}

interface Ref {
  name: string
  sha: string
}

async function resolveRef(ref: string, dir: string): Promise<Ref | undefined> {
  for (const name of [ref, `origin/${ref}`]) {
    const sha = await gitStdout(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], dir)
    if (sha) return { name, sha: sha.trim() }
  }
  return undefined
}

async function defaultBase(dir: string): Promise<Ref | undefined> {
  const originHead = await gitStdout(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    dir,
  )
  const candidates = [originHead?.trim(), 'origin/main', 'origin/master', 'main', 'master']
  for (const c of candidates) {
    if (!c) continue
    const ref = await resolveRef(c, dir)
    if (ref?.name === c) return ref
  }
  return undefined
}

function lines(out: string | undefined): string[] {
  return (out ?? '').split('\n').filter(Boolean)
}

function capped(items: string[], indent = '  '): string {
  const shown = items.slice(0, LIST_MAX).map((l) => indent + l)
  if (items.length > LIST_MAX) shown.push(`${indent}... ${items.length - LIST_MAX} more`)
  return shown.join('\n')
}

const short = (sha: string) => sha.slice(0, 9)

export const gitPrStateTool: Tool = {
  definition: {
    name: 'git_pr_state',
    description:
      'Where a PR branch stands against main, computed by git: merge base and how many commits each side has since, ' +
      "the PR's commits (marking any already on main as an equivalent patch), the files both the PR and main changed " +
      "with main's commits on them, and a real trial merge into main listing conflicting files (or, if clean, what " +
      'the merge would actually change). Use it first when reviewing a branch or PR against main, instead of ' +
      'reading git diff/merge-tree output by hand. Set worktree=true to keep the merged result in a temporary ' +
      'worktree so tests run on the PR merged into main.',
    parameters: {
      type: 'object',
      properties: {
        head: {
          type: 'string',
          description:
            'The PR branch, tag or commit (e.g. "pr-151" or "feature/x"; "origin/" is tried too)',
        },
        base: {
          type: 'string',
          description:
            'Branch to merge into (default: origin/HEAD, else origin/main, origin/master, main, master)',
        },
        fetch: {
          type: 'boolean',
          description:
            'Fetch origin first so main is current (default: true when an origin remote exists)',
        },
        worktree: {
          type: 'boolean',
          description:
            'If the trial merge is clean, keep it committed in a temporary worktree and return its path (default: false)',
        },
        repo_dir: {
          type: 'string',
          description: 'Repository directory (defaults to cwd)',
        },
      },
      required: ['head'],
    },
  },

  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const dir = params.repo_dir ? resolveUserPath(params.repo_dir as string, cwd) : cwd
    const top = await runGit(['rev-parse', '--show-toplevel'], dir)
    if (top.code !== 0) return { success: false, output: 'Not a git repository' }

    const notes: string[] = []
    const hasOrigin = (await gitStdout(['remote'], dir))?.split('\n').includes('origin')
    if ((params.fetch ?? hasOrigin) && hasOrigin) {
      const f = await runGit(['fetch', '--quiet', 'origin'], dir, SLOW_GIT_MS)
      if (f.code !== 0)
        notes.push(`fetch origin failed, using local refs: ${f.stderr.trim().split('\n')[0]}`)
    }

    const headRef = await resolveRef(params.head as string, dir)
    if (!headRef)
      return {
        success: false,
        output: `Unknown ref: ${params.head} (also tried origin/${params.head})`,
      }
    const baseRef = params.base
      ? await resolveRef(params.base as string, dir)
      : await defaultBase(dir)
    if (!baseRef)
      return {
        success: false,
        output: `Unknown base: ${params.base ?? 'no main/master branch found'}`,
      }

    const { name: head, sha: headSha } = headRef
    const { name: base, sha: baseSha } = baseRef
    const mb = (await gitStdout(['merge-base', base, head], dir))?.trim()
    if (!mb) return { success: false, output: `${head} and ${base} share no history` }

    const out: string[] = [`${head} (${short(headSha)}) against ${base} (${short(baseSha)})`]
    out.push(...notes)

    if (mb === headSha) {
      out.push(
        `Already merged: every commit of ${head} is in ${base}. Merging it would change nothing.`,
      )
      return { success: true, output: out.join('\n') }
    }

    const mbLine = (
      await gitStdout(['log', '-1', '--format=%h %ad %s', '--date=short', mb], dir)
    )?.trim()
    const baseCommits = lines(await gitStdout(['rev-list', `${mb}..${base}`], dir)).length
    const prCommits = lines(
      await gitStdout(['log', '--no-merges', '--format=%H %s', `${mb}..${head}`], dir),
    )
    out.push(`Merge base: ${mbLine}`)
    out.push(
      baseCommits === 0
        ? `${base} has no new commits since the merge base (the PR is up to date).`
        : `${base} has ${baseCommits} commit(s) since the merge base. Diffing ${base} against ${head} directly ` +
            `shows those as if the PR removed them; compare from the merge base instead (git diff ${short(mb)} ${head}).`,
    )

    // `git cherry`: "-" marks a PR commit whose patch is already on base (cherry-picked, rebased or re-landed)
    const cherry = lines(await gitStdout(['cherry', base, head], dir))
    const onBase = new Set(cherry.filter((l) => l.startsWith('-')).map((l) => l.slice(2)))
    out.push(`\nPR commits (${prCommits.length}):`)
    out.push(
      capped(
        prCommits.map((c) => {
          const sha = c.slice(0, 40)
          const line = `${short(sha)}${c.slice(40)}`
          return onBase.has(sha) ? `${line}  [already on ${base} as an equivalent patch]` : line
        }),
      ),
    )

    const prFiles = lines(await gitStdout(['diff', '--name-only', mb, head], dir))
    const baseFiles = new Set(lines(await gitStdout(['diff', '--name-only', mb, base], dir)))
    const both = prFiles.filter((f) => baseFiles.has(f))
    out.push(`\nFiles changed by the PR: ${prFiles.length}`)
    if (both.length) {
      out.push(`Also changed on ${base} since the merge base (${both.length}):`)
      const rows: string[] = []
      for (const f of both) {
        const commits = lines(
          await gitStdout(
            ['log', `-${MAIN_COMMITS_PER_FILE}`, '--format=%h %s', `${mb}..${base}`, '--', f],
            dir,
          ),
        )
        rows.push(`${f}\n      ${commits.join('\n      ')}`)
      }
      out.push(capped(rows))
    } else {
      out.push(`None of them changed on ${base} since the merge base.`)
    }

    // Trial merge in a throwaway worktree: the only reliable answer to "does it merge"
    const wt = await mkdtemp(join(tmpdir(), 'egirl-pr-merge-'))
    const add = await runGit(
      ['worktree', 'add', '--quiet', '--detach', wt, baseSha],
      dir,
      SLOW_GIT_MS,
    )
    if (add.code !== 0) {
      out.push(`\nTrial merge not run: git worktree add failed: ${add.stderr.trim()}`)
      return { success: true, output: out.join('\n') }
    }
    let keep = false
    try {
      const ident = ['-c', 'user.name=egirl trial merge', '-c', 'user.email=trial-merge@localhost']
      await runGit([...ident, 'merge', '--no-ff', '--no-commit', headSha], wt, SLOW_GIT_MS)
      const conflicts = lines(await gitStdout(['diff', '--name-only', '--diff-filter=U'], wt))
      if (conflicts.length) {
        out.push(
          `\nTrial merge into ${base}: CONFLICTS in ${conflicts.length} file(s); it cannot merge as-is:`,
        )
        out.push(capped(conflicts))
      } else {
        const net = lines(await gitStdout(['diff', '--cached', '--stat', baseSha], wt))
        if (!net.length) {
          out.push(
            `\nTrial merge into ${base}: clean, and it changes nothing: ${base} already has all of it.`,
          )
        } else {
          out.push(`\nTrial merge into ${base}: clean. What merging would change on ${base}:`)
          out.push(capped(net))
          if (params.worktree) {
            const c = await runGit(
              [...ident, 'commit', '--quiet', '--no-verify', '-m', `trial merge of ${head}`],
              wt,
            )
            if (c.code === 0) {
              keep = true
              const linked = await linkDeps(top.stdout.trim(), wt)
              out.push(
                `\nMerged result kept at ${wt} (detached; run the tests there` +
                  `${linked.length ? `; linked ${linked.join(', ')} from the checkout` : ''}). ` +
                  `Remove it afterwards: git worktree remove --force ${wt}`,
              )
            } else out.push(`\nCould not keep the merged worktree: ${c.stderr.trim()}`)
          }
        }
      }
    } finally {
      if (!keep) await runGit(['worktree', 'remove', '--force', wt], dir, SLOW_GIT_MS)
    }

    return { success: true, output: out.join('\n') }
  },
}
