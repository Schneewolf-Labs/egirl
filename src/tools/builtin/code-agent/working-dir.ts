import { existsSync, statSync } from 'fs'

/**
 * Work out where a code-agent task should run.
 *
 * `working_dir` is optional and the model routinely omits it, even when the task names a
 * repository explicitly. The tool then falls back to the persona workspace, the agent runs
 * somewhere the task makes no sense, and — before the empty-transcript check — reported success.
 *
 * Observed: "the test suite test/tools/missing-dependency.test.ts is failing in
 * /home/nbeerbower/Projects/dummy/egirl, fix it" produced a `code_agent` call with no
 * `working_dir`. Codex ran in ~/.egirl/personas/kira, exited in 0.1s, and the agent reported the
 * work was underway.
 *
 * So: if the model did not say where, and the task text names exactly one existing directory,
 * use it. One candidate only — two paths in a task means the intent is ambiguous and guessing
 * risks editing the wrong repository, which is worse than running in the default and failing
 * loudly.
 */

// Absolute paths, and ~-relative ones. Trailing punctuation is stripped: a path at the end of a
// sentence usually collects a comma or full stop.
const PATH_RE = /(?:^|[\s"'`(])((?:~|\/|[A-Za-z]:[\\/]|\\\\)[\w.~\-\\/]+)/g

export function inferWorkingDir(task: string, home: string): string | undefined {
  const seen = new Set<string>()
  for (const match of task.matchAll(PATH_RE)) {
    const raw = match[1]
    if (!raw) continue
    const cleaned = raw.replace(/[.,;:)\]}'"`]+$/, '')
    if (cleaned.length < 2) continue
    const expanded = cleaned.startsWith('~') ? home + cleaned.slice(1) : cleaned
    try {
      if (existsSync(expanded) && statSync(expanded).isDirectory()) seen.add(expanded)
    } catch {
      // unreadable path — not a candidate
    }
  }
  // Exactly one unambiguous directory, or nothing.
  return seen.size === 1 ? [...seen][0] : undefined
}

export function resolveWorkingDir(opts: {
  explicit?: string
  task: string
  configured?: string
  cwd: string
  home: string
}): { dir: string; inferred: boolean } {
  if (opts.explicit) return { dir: opts.explicit, inferred: false }

  const guess = inferWorkingDir(opts.task, opts.home)
  if (guess) return { dir: guess, inferred: true }

  return { dir: opts.configured ?? opts.cwd, inferred: false }
}
