import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { parse } from 'smol-toml'

/**
 * Drop-in config fragments, `egirl.d/*.toml` beside the main config.
 *
 * One file defining every instance means every edit risks every instance: adding a second
 * operator meant hand-editing the same file that a running instance loads, and `egirl new`
 * appending to it. A fragment per instance shrinks that blast radius to one file, and makes the
 * scaffolder's write a create rather than an append.
 *
 * It also matters that `egirl.toml` is tracked in git. Live config drift shows up as a permanent
 * working-tree diff, and one careless `git add -A` commits whatever hosts and tokens are in it.
 * Fragments give the per-machine parts somewhere to live that the repo can ignore.
 */

export interface ConfigFragmentFile {
  path: string
  toml: Record<string, unknown>
}

export const FRAGMENT_DIR = 'egirl.d'

/**
 * Fragment files in load order.
 *
 * Sorted by filename so the result does not depend on directory order, which varies by
 * filesystem -- two machines with identical files would otherwise resolve conflicting keys
 * differently, and the difference would only show where two fragments overlap.
 */
export function findConfigFragments(configPath: string): string[] {
  const dir = join(dirname(configPath), FRAGMENT_DIR)
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.toml'))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * Parse every fragment, failing loudly on a broken one.
 *
 * Skipping an unparseable fragment would start the agent with an instance silently missing, or
 * running on the base config's defaults -- which is worse than not starting, because it looks
 * like it worked.
 */
export function loadConfigFragments(configPath: string): ConfigFragmentFile[] {
  return findConfigFragments(configPath).map((path) => {
    try {
      return { path, toml: parse(readFileSync(path, 'utf-8')) as Record<string, unknown> }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to parse config fragment ${path}: ${detail}`)
    }
  })
}
