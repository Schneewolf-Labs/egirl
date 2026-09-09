import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseUpdateArgs, runUpdate } from '../../src/commands/update'
import { gitStdout, runGit } from '../../src/util/git'

let root: string
let origin: string
let local: string
let publisher: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, cwd)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function commitFile(cwd: string, name: string, content: string): Promise<void> {
  writeFileSync(join(cwd, name), content)
  await git(cwd, 'add', name)
  await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `add ${name}`)
}

async function publish(name: string, content: string): Promise<void> {
  await commitFile(publisher, name, content)
  await git(publisher, 'push', '-q', 'origin', 'main')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'egirl-update-'))
  origin = join(root, 'origin.git')
  local = join(root, 'local')
  publisher = join(root, 'publisher')
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  await git(root, 'clone', '-q', origin, publisher)
  await git(publisher, 'checkout', '-q', '-b', 'main')
  await commitFile(publisher, 'package.json', '{}')
  await git(publisher, 'push', '-q', '-u', 'origin', 'main')
  await git(root, 'clone', '-q', origin, local)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('parseUpdateArgs accepts --check and rejects junk', () => {
  expect(parseUpdateArgs([]).checkOnly).toBe(false)
  expect(parseUpdateArgs(['--check']).checkOnly).toBe(true)
  expect(() => parseUpdateArgs(['--yolo'])).toThrow('Unknown option')
})

test('no-op when already at upstream', async () => {
  const before = await gitStdout(['rev-parse', 'HEAD'], local)
  await runUpdate([], { repoDir: local, install: async () => true })
  expect(await gitStdout(['rev-parse', 'HEAD'], local)).toBe(before)
})

test('fast-forwards to upstream and skips install when deps are unchanged', async () => {
  await publish('a.txt', 'a')
  const target = await git(publisher, 'rev-parse', 'HEAD')
  let installed = false
  await runUpdate([], {
    repoDir: local,
    install: async () => {
      installed = true
      return true
    },
  })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(target)
  expect(installed).toBe(false)
})

test('runs install when the lockfile moved', async () => {
  await publish('bun.lock', 'lock v2')
  let installDir: string | undefined
  await runUpdate([], {
    repoDir: local,
    install: async (dir) => {
      installDir = dir
      return true
    },
  })
  expect(installDir).toBe(local)
})

test('--check reports without moving HEAD', async () => {
  await publish('a.txt', 'a')
  const before = await git(local, 'rev-parse', 'HEAD')
  await runUpdate(['--check'], { repoDir: local, install: async () => true })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(before)
})

test('refuses a dirty working tree', async () => {
  await publish('a.txt', 'a')
  writeFileSync(join(local, 'package.json'), '{"dirty":true}')
  await expect(runUpdate([], { repoDir: local, install: async () => true })).rejects.toThrow(
    'uncommitted changes',
  )
})

test('refuses when local has commits upstream lacks', async () => {
  await publish('a.txt', 'a')
  await commitFile(local, 'mine.txt', 'mine')
  await expect(runUpdate([], { repoDir: local, install: async () => true })).rejects.toThrow(
    'local commit(s)',
  )
})

test('refuses a directory that is not a git checkout', async () => {
  await expect(runUpdate([], { repoDir: root, install: async () => true })).rejects.toThrow(
    'not a git checkout',
  )
})
