/**
 * Drop-in config fragments.
 *
 * The behaviours worth pinning: load order must not depend on the filesystem, a fragment must
 * merge rather than replace, and a broken fragment must stop startup rather than quietly
 * removing an instance from the effective config.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findConfigFragments, loadConfigFragments } from '../../src/config/fragments'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sandbox(fragments: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-frag-'))
  dirs.push(dir)
  const configPath = join(dir, 'egirl.toml')
  writeFileSync(configPath, 'theme = "egirl"\n')

  if (Object.keys(fragments).length > 0) {
    mkdirSync(join(dir, 'egirl.d'), { recursive: true })
    for (const [name, content] of Object.entries(fragments)) {
      writeFileSync(join(dir, 'egirl.d', name), content)
    }
  }
  return configPath
}

describe('findConfigFragments', () => {
  test('no egirl.d directory is not an error', () => {
    expect(findConfigFragments(sandbox({}))).toEqual([])
  })

  test('returns fragments in filename order regardless of creation order', () => {
    // Directory order varies by filesystem; without the sort, two machines with identical files
    // would resolve overlapping keys differently and only differ where the fragments overlap.
    const config = sandbox({ 'zzz.toml': '', 'aaa.toml': '', 'mmm.toml': '' })
    expect(findConfigFragments(config).map((p) => p.split('/').pop())).toEqual([
      'aaa.toml',
      'mmm.toml',
      'zzz.toml',
    ])
  })

  test('ignores files that are not .toml', () => {
    const config = sandbox({ 'a.toml': '', 'notes.md': 'x', 'b.toml.bak': 'x' })
    expect(findConfigFragments(config)).toHaveLength(1)
  })
})

describe('loadConfigFragments', () => {
  test('parses each fragment', () => {
    const config = sandbox({ 'zero.toml': '[instances.zero]\nprofile = "big-box"\n' })
    const loaded = loadConfigFragments(config)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.toml).toEqual({ instances: { zero: { profile: 'big-box' } } })
  })

  test('a broken fragment throws instead of being skipped', () => {
    // Skipping it would start the agent with an instance silently missing, or running on the
    // base config's defaults — which is worse than not starting, because it looks like it worked.
    const config = sandbox({ 'broken.toml': 'this is not = = toml\n' })
    expect(() => loadConfigFragments(config)).toThrow(/broken\.toml/)
  })

  test('the error names the file, since the base config parsed fine', () => {
    const config = sandbox({ 'bad.toml': '[[[\n' })
    expect(() => loadConfigFragments(config)).toThrow(/Failed to parse config fragment/)
  })
})
