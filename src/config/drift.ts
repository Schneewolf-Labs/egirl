/**
 * Whether the config files changed after this process read them.
 *
 * egirl.toml and egirl.d/*.toml are read once, at startup. An edit made while an instance runs
 * does nothing until the restart, and nothing said so: an operator raised max_turns in its
 * fragment and kept running on the old cap, unsure whether the change had taken. This keeps the
 * files' modification times from startup so /settings can say which ones differ now.
 */

import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { findConfigFragments } from './fragments'

export interface ConfigDrift {
  /** Config files edited, added or removed since startup, as short labels. Empty: none. */
  changed(): string[]
}

export function watchConfigFiles(
  source: { path?: string; fragments?: string[] },
  stat: (path: string) => number | undefined = mtimeOf,
): ConfigDrift {
  const main = source.path
  if (!main) return { changed: () => [] }
  const files = [main, ...(source.fragments ?? [])]
  const atStart = new Map(files.map((f) => [f, stat(f)]))
  const label = (f: string) => (f === main ? basename(f) : `${basename(dirname(f))}/${basename(f)}`)

  return {
    changed() {
      const out: string[] = []
      for (const [file, was] of atStart) {
        const now = stat(file)
        if (now === undefined) out.push(`${label(file)} (removed)`)
        else if (now !== was) out.push(`${label(file)} (edited)`)
      }
      for (const file of findConfigFragments(main)) {
        if (!atStart.has(file)) out.push(`${label(file)} (added)`)
      }
      return out
    },
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
