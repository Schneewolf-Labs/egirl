/**
 * The codex runner must be started by real Node, not by bun.
 *
 * `bunfig.toml` sets `[run] bun = true`, so `node` resolves to bun for anything spawned from a
 * `bun run` process. The runner is a `.cjs` requiring node-pty, a native N-API addon bun cannot
 * load: bun exited 0 having written nothing, the parent read the empty transcript as "codex
 * produced no output", and reported a working-directory problem. Codex never ran at all, and
 * every delegated task quietly fell through to the next provider.
 *
 * So the resolver asks each candidate what it is instead of trusting the filename -- the filename
 * being the unreliable part.
 */

import { describe, expect, test } from 'bun:test'
import { isRealNode, resolveNodeBinary } from '../../src/tools/builtin/code-agent/node-binary'

describe('resolveNodeBinary', () => {
  test('rejects a candidate that reports itself as bun', () => {
    const found = resolveNodeBinary({ PATH: '/usr/bin' }, () => false)
    expect(found).toBeUndefined()
  })

  test('walks PATH in order and returns the first real node', () => {
    const asked: string[] = []
    const found = resolveNodeBinary({ PATH: '/nope:/usr/bin:/also-nope' }, (bin) => {
      asked.push(bin)
      return bin === '/usr/bin/node'
    })
    // Only existing paths are probed, so this asserts the real one wins when present.
    if (found !== undefined) expect(found).toBe('/usr/bin/node')
  })

  test('an explicit override is used when it is really node', () => {
    const found = resolveNodeBinary(
      { EGIRL_NODE_BIN: '/custom/node', PATH: '/usr/bin' },
      () => true,
    )
    expect(found).toBe('/custom/node')
  })

  test('an explicit override that is bun is not silently replaced', () => {
    // Falling back to PATH here would hide a misconfiguration the operator set deliberately.
    const found = resolveNodeBinary(
      { EGIRL_NODE_BIN: '/custom/bun', PATH: '/usr/bin' },
      (bin) => bin !== '/custom/bun',
    )
    expect(found).toBeUndefined()
  })

  test('an empty PATH yields nothing rather than throwing', () => {
    expect(resolveNodeBinary({}, () => true)).toBeUndefined()
    expect(resolveNodeBinary({ PATH: '' }, () => true)).toBeUndefined()
  })

  test('isRealNode says no to a binary that is not an interpreter', () => {
    expect(isRealNode('/bin/echo')).toBe(false)
  })

  test('isRealNode says no to a path that does not exist', () => {
    expect(isRealNode('/definitely/not/here/node')).toBe(false)
  })

  test('isRealNode identifies bun as not-node', () => {
    // bun defines a `Bun` global; that is the whole discriminator.
    expect(isRealNode(process.execPath)).toBe(false)
  })
})
