/**
 * `egirl install` writes a launcher that runs this checkout from any directory.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, launcherScript, parseInstallArgs } from '../../src/commands/install'

const tmp = () => mkdtempSync(join(tmpdir(), 'egirl-install-'))

describe('launcherScript', () => {
  test('pins the checkout config and .env, but a local egirl.toml or .env wins', () => {
    const s = launcherScript('/opt/egirl')
    expect(s.startsWith('#!/bin/sh')).toBe(true)
    expect(s).toContain(`REPO='/opt/egirl'`)
    expect(s).toContain('[ ! -f egirl.toml ]')
    expect(s).toContain('--env-file="$REPO/.env"')
    expect(s).toContain('exec bun "$REPO/src/index.ts" "$@"')
  })

  test('quotes a path with a quote in it', () => {
    expect(launcherScript("/it's/here")).toContain(`REPO='/it'\\''s/here'`)
  })
})

describe('install', () => {
  test('writes an executable launcher and says when its directory is not on PATH', () => {
    const binDir = join(tmp(), 'bin')
    const lines = install({ binDir, force: false }, '/opt/egirl', '/usr/bin')
    const target = join(binDir, 'egirl')
    expect(readFileSync(target, 'utf-8')).toBe(launcherScript('/opt/egirl'))
    expect(statSync(target).mode & 0o111).toBeTruthy()
    expect(lines.join('\n')).toContain('is not on PATH')
    expect(install({ binDir, force: false }, '/opt/egirl', binDir).join('\n')).not.toContain(
      'not on PATH',
    )
  })

  test('replaces its own launcher, refuses anything else without --force', () => {
    const binDir = tmp()
    const target = join(binDir, 'egirl')
    install({ binDir, force: false }, '/a', binDir)
    install({ binDir, force: false }, '/b', binDir)
    expect(readFileSync(target, 'utf-8')).toContain(`REPO='/b'`)

    writeFileSync(target, '#!/bin/sh\necho someone else\n')
    expect(() => install({ binDir, force: false }, '/c', binDir)).toThrow('--force')
    install({ binDir, force: true }, '/c', binDir)
    expect(readFileSync(target, 'utf-8')).toContain(`REPO='/c'`)
  })

  test('defaults to ~/.local/bin and reads --bin-dir', () => {
    expect(parseInstallArgs([]).binDir.endsWith(join('.local', 'bin'))).toBe(true)
    expect(parseInstallArgs(['--bin-dir', '/x/bin', '--force'])).toEqual({
      binDir: '/x/bin',
      force: true,
    })
  })
})
