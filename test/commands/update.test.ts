import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { latestReleaseTag, parseUpdateArgs, runUpdate } from '../../src/commands/update'
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

/** Tag the publisher's HEAD (annotated, as a real release would be) and push the tag. */
async function release(tag: string): Promise<void> {
  await git(publisher, '-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', tag, '-m', tag)
  await git(publisher, 'push', '-q', 'origin', tag)
}

const noInstall = { install: async () => true }

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

test('parseUpdateArgs accepts --check and --edge and rejects junk', () => {
  expect(parseUpdateArgs([])).toEqual({ checkOnly: false, edge: false })
  expect(parseUpdateArgs(['--check']).checkOnly).toBe(true)
  expect(parseUpdateArgs(['--edge']).edge).toBe(true)
  expect(() => parseUpdateArgs(['--yolo'])).toThrow('Unknown option')
})

test('--edge: no-op when already at upstream', async () => {
  const before = await gitStdout(['rev-parse', 'HEAD'], local)
  await runUpdate(['--edge'], { repoDir: local, install: async () => true })
  expect(await gitStdout(['rev-parse', 'HEAD'], local)).toBe(before)
})

test('--edge: fast-forwards to upstream and skips install when deps are unchanged', async () => {
  await publish('a.txt', 'a')
  const target = await git(publisher, 'rev-parse', 'HEAD')
  let installed = false
  await runUpdate(['--edge'], {
    repoDir: local,
    install: async () => {
      installed = true
      return true
    },
  })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(target)
  expect(installed).toBe(false)
})

test('--edge: runs install when the lockfile moved', async () => {
  await publish('bun.lock', 'lock v2')
  let installDir: string | undefined
  await runUpdate(['--edge'], {
    repoDir: local,
    install: async (dir) => {
      installDir = dir
      return true
    },
  })
  expect(installDir).toBe(local)
})

test('--edge --check reports without moving HEAD', async () => {
  await publish('a.txt', 'a')
  const before = await git(local, 'rev-parse', 'HEAD')
  await runUpdate(['--edge', '--check'], { repoDir: local, install: async () => true })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(before)
})

test('refuses a dirty working tree', async () => {
  await publish('a.txt', 'a')
  writeFileSync(join(local, 'package.json'), '{"dirty":true}')
  await expect(
    runUpdate(['--edge'], { repoDir: local, install: async () => true }),
  ).rejects.toThrow('uncommitted changes')
})

test('--edge: refuses when local has commits upstream lacks', async () => {
  await publish('a.txt', 'a')
  await commitFile(local, 'mine.txt', 'mine')
  await expect(
    runUpdate(['--edge'], { repoDir: local, install: async () => true }),
  ).rejects.toThrow('not in origin/main')
})

test('refuses a directory that is not a git checkout', async () => {
  await expect(runUpdate(['--edge'], { repoDir: root, install: async () => true })).rejects.toThrow(
    'not a git checkout',
  )
})

test('latestReleaseTag compares numerically and skips pre-releases', () => {
  expect(latestReleaseTag(['v1.2.0', 'v1.10.0', 'v1.9.3'])).toBe('v1.10.0')
  expect(latestReleaseTag(['v1.0.0', 'v2.0.0-rc.1', 'nightly'])).toBe('v1.0.0')
  expect(latestReleaseTag(['', 'nope'])).toBeUndefined()
})

test('default: refuses with a pointer to --edge when there are no releases', async () => {
  await publish('a.txt', 'a')
  await expect(runUpdate([], { repoDir: local, ...noInstall })).rejects.toThrow('--edge')
})

test('default: moves to the latest release tag, not the branch tip', async () => {
  await publish('a.txt', 'a')
  await release('v1.0.0')
  await publish('b.txt', 'b')
  await release('v1.1.0')
  const tagged = await git(publisher, 'rev-parse', 'HEAD')
  await publish('unreleased.txt', 'wip')

  await runUpdate([], { repoDir: local, ...noInstall })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(tagged)
  expect(await git(local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
})

test('default: a checkout already past the latest release stays put', async () => {
  await release('v1.0.0')
  await publish('a.txt', 'a')
  await git(local, 'pull', '-q')
  const before = await git(local, 'rev-parse', 'HEAD')
  await runUpdate([], { repoDir: local, ...noInstall })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(before)
})

test('default: updates a detached checkout of an older tag', async () => {
  await release('v1.0.0')
  await publish('a.txt', 'a')
  await release('v1.1.0')
  await git(local, 'fetch', '-q', '--tags')
  await git(local, 'checkout', '-q', 'v1.0.0')

  await runUpdate([], { repoDir: local, ...noInstall })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(await git(publisher, 'rev-parse', 'HEAD'))
})

test('default: refuses local commits the release lacks', async () => {
  await publish('a.txt', 'a')
  await release('v1.0.0')
  await commitFile(local, 'mine.txt', 'mine')
  await expect(runUpdate([], { repoDir: local, ...noInstall })).rejects.toThrow('not in v1.0.0')
})
