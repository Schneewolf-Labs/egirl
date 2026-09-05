import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundleIdToBrowser,
  cleanupRealProfileStore,
  desktopToBrowser,
  lastUsedProfile,
  snapshotRealProfile,
} from '../../src/browser/real-profile'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'egirl-real-profile-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeLocalState(dir: string, lastUsed?: string): void {
  const state = lastUsed ? { profile: { last_used: lastUsed } } : {}
  writeFileSync(join(dir, 'Local State'), JSON.stringify(state), 'utf8')
}

function createCookieDb(path: string, value: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, value TEXT)')
  db.exec('DELETE FROM cookies')
  db.query('INSERT INTO cookies (host_key, value) VALUES (?, ?)').run('example.com', value)
  db.close()
}

function readCookieValue(path: string): string | undefined {
  const db = new Database(path, { readonly: true })
  try {
    const row = db.query('SELECT value FROM cookies').get() as { value: string } | null
    return row?.value
  } finally {
    db.close()
  }
}

/** Fake user-data-dir with an active non-Default profile, like real Chrome. */
function makeFakeProfile(root: string): string {
  const src = join(root, 'google-chrome')
  const profile = join(src, 'Profile 6')
  mkdirSync(join(profile, 'Network'), { recursive: true })
  mkdirSync(join(profile, 'Cache'), { recursive: true })
  mkdirSync(join(profile, 'Extensions'), { recursive: true })
  mkdirSync(join(profile, 'Local Storage'), { recursive: true })
  writeLocalState(src, 'Profile 6')
  createCookieDb(join(profile, 'Network', 'Cookies'), 'session-token')
  createCookieDb(join(profile, 'Web Data'), 'autofill')
  writeFileSync(join(profile, 'Preferences'), '{"profile":{}}', 'utf8')
  writeFileSync(join(profile, 'Cache', 'blob'), 'cached junk', 'utf8')
  writeFileSync(join(profile, 'Local Storage', 'leveldb.log'), 'ls data', 'utf8')
  writeFileSync(join(src, 'SingletonLock'), '', 'utf8')
  return src
}

describe('desktopToBrowser', () => {
  test('maps stable browsers', () => {
    expect(desktopToBrowser('google-chrome.desktop')).toEqual({ ok: true, browser: 'chrome' })
    expect(desktopToBrowser('brave-browser.desktop')).toEqual({ ok: true, browser: 'brave' })
    expect(desktopToBrowser('com.google.Chrome.desktop')).toEqual({ ok: true, browser: 'chrome' })
    expect(desktopToBrowser('microsoft-edge.desktop')).toEqual({ ok: true, browser: 'edge' })
    expect(desktopToBrowser('chromium.desktop')).toEqual({ ok: true, browser: 'chromium' })
  })

  test('rejects pre-release channels instead of resolving to stable', () => {
    const result = desktopToBrowser('google-chrome-beta.desktop')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('pre-release')
  })

  test('rejects non-Chromium browsers', () => {
    const result = desktopToBrowser('firefox.desktop')
    expect(result.ok).toBe(false)
  })
})

describe('bundleIdToBrowser', () => {
  test('maps stable bundle ids exactly', () => {
    expect(bundleIdToBrowser('com.google.Chrome')).toEqual({ ok: true, browser: 'chrome' })
    expect(bundleIdToBrowser('com.brave.Browser')).toEqual({ ok: true, browser: 'brave' })
  })

  test('does not read a channel bundle as stable', () => {
    expect(bundleIdToBrowser('com.google.chrome.beta').ok).toBe(false)
  })
})

describe('lastUsedProfile', () => {
  test('returns the last_used profile when it exists', () => {
    mkdirSync(join(tmp, 'Profile 6'), { recursive: true })
    writeLocalState(tmp, 'Profile 6')
    expect(lastUsedProfile(tmp)).toBe('Profile 6')
  })

  test('falls back to Default when Local State is missing', () => {
    expect(lastUsedProfile(tmp)).toBe('Default')
  })

  test('falls back to Default when last_used names a missing dir', () => {
    writeLocalState(tmp, 'Profile 9')
    expect(lastUsedProfile(tmp)).toBe('Default')
  })
})

describe('snapshotRealProfile', () => {
  test('mirrors the active profile into the snapshot Default slot', () => {
    const src = makeFakeProfile(tmp)
    const store = join(tmp, 'store')

    const result = snapshotRealProfile('chrome', store, src)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const dst = result.dir
    expect(readCookieValue(join(dst, 'Default', 'Network', 'Cookies'))).toBe('session-token')
    expect(readCookieValue(join(dst, 'Default', 'Web Data'))).toBe('autofill')
    expect(existsSync(join(dst, 'Default', 'Preferences'))).toBe(true)
    expect(existsSync(join(dst, 'Default', 'Local Storage', 'leveldb.log'))).toBe(true)
    expect(existsSync(join(dst, 'Local State'))).toBe(true)
    expect(existsSync(join(dst, '.egirl-snapshot-complete'))).toBe(true)
  })

  test('excludes caches, extensions, and live-instance leftovers', () => {
    const src = makeFakeProfile(tmp)
    const store = join(tmp, 'store')

    const result = snapshotRealProfile('chrome', store, src)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(existsSync(join(result.dir, 'Default', 'Cache'))).toBe(false)
    expect(existsSync(join(result.dir, 'Default', 'Extensions'))).toBe(false)
    expect(existsSync(join(result.dir, 'SingletonLock'))).toBe(false)
  })

  test('re-syncs auth files on subsequent calls (fresh logins show up)', () => {
    const src = makeFakeProfile(tmp)
    const store = join(tmp, 'store')

    expect(snapshotRealProfile('chrome', store, src).ok).toBe(true)
    createCookieDb(join(src, 'Profile 6', 'Network', 'Cookies'), 'fresh-token')

    const result = snapshotRealProfile('chrome', store, src)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readCookieValue(join(result.dir, 'Default', 'Network', 'Cookies'))).toBe('fresh-token')
  })

  test.skipIf(process.platform === 'win32')(
    'locks the store down to POSIX owner-only permissions',
    () => {
      const src = makeFakeProfile(tmp)
      const store = join(tmp, 'store')

      const result = snapshotRealProfile('chrome', store, src)
      expect(result.ok).toBe(true)
      expect(statSync(store).mode & 0o777).toBe(0o700)
    },
  )

  test('fails when the profile directory does not exist', () => {
    const result = snapshotRealProfile('chrome', join(tmp, 'store'), join(tmp, 'nope'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not found')
  })
})

describe('cleanupRealProfileStore', () => {
  test('removes the store and is a no-op when absent', () => {
    const store = join(tmp, 'store')
    mkdirSync(join(store, 'chrome'), { recursive: true })
    writeFileSync(join(store, 'chrome', 'Local State'), '{}', 'utf8')

    cleanupRealProfileStore(store)
    expect(existsSync(store)).toBe(false)
    cleanupRealProfileStore(store)
  })
})
