import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'

/**
 * Real-profile browsing: snapshot the user's default Chromium browser's ACTIVE
 * profile (cookies, logins, preferences — never caches or extensions) into an
 * egirl-owned directory, so the browser tools can be driven with the user's
 * real logins via the user's real browser binary.
 *
 * The live profile is never opened directly: the snapshot is a separate
 * user-data-dir, so it doesn't fight the user's running browser for the
 * profile lock and it sidesteps Chrome 136+'s block on remote automation of
 * the default profile directory. Design ported from Hermes Agent's
 * `browser.use_real_profile` (hermes_cli/browser_connect.py).
 */

export type ChromiumBrowser = 'chrome' | 'chromium' | 'brave' | 'edge'

export type RealProfileResult =
  | { ok: true; userDataDir: string; executablePath: string }
  | { ok: false; reason: string }

type DetectResult = { ok: true; browser: ChromiumBrowser } | { ok: false; reason: string }

// Linux xdg default-web-browser .desktop fragments → browser key. Channel
// builds (beta/dev/canary/nightly) are matched FIRST and rejected: their
// profiles live in channel-specific dirs we don't resolve, and silently
// driving the stable profile instead could act as a different account.
const LINUX_CHANNEL_FRAGMENTS = [
  'google-chrome-beta',
  'google-chrome-unstable',
  'google-chrome-canary',
  'com.google.chrome.beta',
  'com.google.chrome.dev',
  'com.google.chrome.canary',
  'microsoft-edge-beta',
  'microsoft-edge-dev',
  'microsoft-edge-canary',
  'brave-browser-beta',
  'brave-browser-nightly',
  'brave-browser-dev',
]

const LINUX_DESKTOP_MAP: Array<[string, ChromiumBrowser]> = [
  ['google-chrome', 'chrome'],
  ['com.google.chrome', 'chrome'],
  ['chromium', 'chromium'],
  ['brave', 'brave'],
  ['microsoft-edge', 'edge'],
  ['com.microsoft.edge', 'edge'],
  ['msedge', 'edge'],
]

// macOS LaunchServices https-handler bundle ids → browser key. Exact match:
// `com.google.chrome.beta` must not be read as `com.google.chrome`.
const DARWIN_BUNDLE_MAP: Array<[string, ChromiumBrowser]> = [
  ['com.google.chrome', 'chrome'],
  ['com.microsoft.edgemac', 'edge'],
  ['com.brave.browser', 'brave'],
  ['org.chromium.chromium', 'chromium'],
]

/** Map a Linux .desktop file name to a supported browser, rejecting channels. */
export function desktopToBrowser(desktopFile: string): DetectResult {
  const name = desktopFile.toLowerCase().replace(/\.desktop$/, '')
  for (const fragment of LINUX_CHANNEL_FRAGMENTS) {
    if (name.includes(fragment)) {
      return {
        ok: false,
        reason:
          `default browser "${desktopFile}" is a pre-release Chromium channel, ` +
          'which real-profile browsing does not support. Set your default to a ' +
          'stable Chrome / Edge / Brave / Chromium.',
      }
    }
  }
  for (const [fragment, browser] of LINUX_DESKTOP_MAP) {
    if (name.includes(fragment)) {
      return { ok: true, browser }
    }
  }
  return {
    ok: false,
    reason:
      `default browser "${desktopFile}" is not a supported Chromium browser ` +
      '(Chrome, Edge, Brave, Chromium). Real-profile browsing requires a Chromium default.',
  }
}

/** Map a macOS https-handler bundle id to a supported browser (exact match). */
export function bundleIdToBrowser(bundleId: string): DetectResult {
  const id = bundleId.toLowerCase()
  for (const [bundle, browser] of DARWIN_BUNDLE_MAP) {
    if (id === bundle) {
      return { ok: true, browser }
    }
  }
  return {
    ok: false,
    reason:
      `default browser "${bundleId}" is not a supported stable Chromium browser ` +
      '(Chrome, Edge, Brave, Chromium). Real-profile browsing requires a Chromium default.',
  }
}

function detectDefaultChromium(): DetectResult {
  if (process.platform === 'linux') {
    const proc = spawnSync('xdg-settings', ['get', 'default-web-browser'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const desktop = (proc.stdout ?? '').trim()
    if (proc.status !== 0 || !desktop) {
      return { ok: false, reason: 'could not determine the default browser (xdg-settings failed)' }
    }
    return desktopToBrowser(desktop)
  }
  if (process.platform === 'darwin') {
    const plist = join(
      homedir(),
      'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
    )
    const proc = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (proc.status !== 0) {
      return { ok: false, reason: 'could not read the default browser from LaunchServices' }
    }
    try {
      const parsed = JSON.parse(proc.stdout) as {
        LSHandlers?: Array<{ LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }>
      }
      const handler = parsed.LSHandlers?.find(
        (h) => h.LSHandlerURLScheme === 'https' && h.LSHandlerRoleAll,
      )
      if (!handler?.LSHandlerRoleAll) {
        // No explicit handler means the system default (Safari) — not Chromium.
        return {
          ok: false,
          reason:
            'the default browser appears to be Safari, which real-profile browsing ' +
            'does not support. Set a Chromium browser (Chrome, Edge, Brave) as default.',
        }
      }
      return bundleIdToBrowser(handler.LSHandlerRoleAll)
    } catch {
      return { ok: false, reason: 'could not parse the LaunchServices default-browser record' }
    }
  }
  return {
    ok: false,
    reason: `real-profile browsing is not supported on platform "${process.platform}"`,
  }
}

/** Default user-data-dir for a Chromium browser, or undefined when none exists. */
export function realProfileDataDir(browser: ChromiumBrowser): string | undefined {
  const home = homedir()
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    const parts: Record<ChromiumBrowser, string[]> = {
      chrome: ['Google', 'Chrome'],
      chromium: ['Chromium'],
      brave: ['BraveSoftware', 'Brave-Browser'],
      edge: ['Microsoft Edge'],
    }
    candidates.push(join(support, ...parts[browser]))
  } else {
    const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
    const names: Record<ChromiumBrowser, string[]> = {
      chrome: ['google-chrome'],
      chromium: ['chromium'],
      brave: ['BraveSoftware', 'Brave-Browser'],
      edge: ['microsoft-edge'],
    }
    candidates.push(join(config, ...names[browser]))
    if (browser === 'chromium') {
      candidates.push(join(home, 'snap', 'chromium', 'common', 'chromium'))
    }
    if (browser === 'brave') {
      candidates.push(
        join(home, 'snap', 'brave', 'current', '.config', 'BraveSoftware', 'Brave-Browser'),
      )
    }
    const flatpakIds: Record<ChromiumBrowser, string> = {
      chrome: 'com.google.Chrome',
      chromium: 'org.chromium.Chromium',
      brave: 'com.brave.Browser',
      edge: 'com.microsoft.Edge',
    }
    candidates.push(join(home, '.var', 'app', flatpakIds[browser], 'config', ...names[browser]))
  }
  return candidates.find((c) => existsSync(c))
}

/** Locate the browser's real executable so the launched session IS the user's browser. */
export function findBrowserExecutable(browser: ChromiumBrowser): string | undefined {
  if (process.platform === 'darwin') {
    const apps: Record<ChromiumBrowser, string> = {
      chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    }
    return existsSync(apps[browser]) ? apps[browser] : undefined
  }
  const names: Record<ChromiumBrowser, string[]> = {
    chrome: ['google-chrome-stable', 'google-chrome'],
    chromium: ['chromium', 'chromium-browser'],
    brave: ['brave-browser', 'brave'],
    edge: ['microsoft-edge-stable', 'microsoft-edge', 'msedge'],
  }
  const paths: Record<ChromiumBrowser, string[]> = {
    chrome: ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    brave: [
      '/usr/bin/brave-browser',
      '/opt/brave.com/brave/brave-browser',
      '/opt/brave-bin/brave',
      '/snap/bin/brave',
    ],
    edge: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'],
  }
  for (const name of names[browser]) {
    const found = Bun.which(name)
    if (found) return found
  }
  return paths[browser].find((p) => existsSync(p))
}

// Directory/file basenames excluded from the initial profile-tree copy:
// caches/telemetry AND heavy, replay-prone state (extensions and their service
// workers spin up on launch and can wedge a fresh renderer; IndexedDB/GPUCache
// add hundreds of MB). What remains is auth/login state plus Local Storage —
// the point of the feature — turning a multi-hundred-MB profile into a few MB.
const SNAPSHOT_IGNORES = [
  '*Cache*',
  'Extensions',
  'Extension*',
  'Local Extension Settings',
  'Service Worker',
  'IndexedDB',
  'Crash Reports',
  'Crashpad',
  'BrowserMetrics*',
  'Snapshots',
  'OptimizationGuide*',
  'optimization_guide_model_store',
  'Safe Browsing',
  'SafetyTips',
  'OnDeviceHeadSuggestModel',
  'segmentation_platform',
  'Sync Data',
  'Shared Dictionary',
  'History*',
  'Favicons*',
  'Singleton*',
  'RunningChromeVersion',
  '*.tmp',
  // SQLite sidecars: the auth DBs are copied via VACUUM INTO (self-contained,
  // committed state folded in); a stale raw sidecar next to one corrupts it.
  '*-journal',
  '*-wal',
  '*-shm',
]

// Auth files re-synced from the live profile on EVERY launch (the full tree is
// only copied once), relative to a profile dir (Default, "Profile 6", ...).
const AUTH_REFRESH_FILES = [
  'Cookies',
  join('Network', 'Cookies'),
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'Preferences',
]

// Auth files that are SQLite databases — copied via VACUUM INTO so the copy is
// a consistent committed snapshot even while the user's browser is writing.
const SQLITE_AUTH_DBS = new Set(['Cookies', 'Login Data', 'Login Data For Account', 'Web Data'])

const SNAPSHOT_DONE_MARKER = '.egirl-snapshot-complete'

const IGNORE_REGEXES = SNAPSHOT_IGNORES.map(
  (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
)

function isIgnored(name: string): boolean {
  return IGNORE_REGEXES.some((re) => re.test(name)) || SQLITE_AUTH_DBS.has(name)
}

/** Profile dir the user actually browses (Local State → profile.last_used). */
export function lastUsedProfile(userDataDir: string): string {
  try {
    const state = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8')) as {
      profile?: { last_used?: unknown }
    }
    const last = state.profile?.last_used
    if (typeof last === 'string' && last && existsSync(join(userDataDir, last))) {
      return last
    }
  } catch {
    // Missing/unreadable Local State — fall through to Default.
  }
  return 'Default'
}

function copySqliteDb(src: string, dst: string): boolean {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    rmSync(dst, { force: true })
    const db = new Database(src, { readonly: true })
    try {
      db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    // A VACUUM'd copy is self-contained; stale sidecars from an older raw copy
    // would corrupt it.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      rmSync(dst + suffix, { force: true })
    }
    return true
  } catch (error) {
    log.debug('browser', `sqlite copy of ${basename(src)} failed, trying raw copy:`, error)
  }
  try {
    copyFileSync(src, dst)
    // Raw copy: bring the matching sidecars along (or clear stale ones) so a
    // WAL-mode database stays openable.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(src + suffix)) {
        copyFileSync(src + suffix, dst + suffix)
      } else {
        rmSync(dst + suffix, { force: true })
      }
    }
    return true
  } catch (error) {
    log.warn('browser', `could not copy ${basename(src)}:`, error)
    return false
  }
}

/** Copy the active profile's auth files into the snapshot's Default slot. */
function mirrorProfileAuth(src: string, dst: string, sourceProfile: string): number {
  const dstDefault = join(dst, 'Default')
  let failedDbs = 0
  for (const rel of AUTH_REFRESH_FILES) {
    const from = join(src, sourceProfile, rel)
    if (!existsSync(from)) continue
    const to = join(dstDefault, rel)
    if (SQLITE_AUTH_DBS.has(basename(rel))) {
      if (!copySqliteDb(from, to)) failedDbs++
    } else {
      try {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
      } catch (error) {
        log.debug('browser', `real-profile: could not copy ${rel}:`, error)
      }
    }
  }
  return failedDbs
}

/**
 * Snapshot the browser's real ACTIVE profile into `storeDir/<browser>`.
 *
 * The active profile (Local State → profile.last_used) is mirrored into the
 * copy's `Default` — which is what the launched browser opens — so the session
 * lands on the user's real signed-in state even when they browse in a
 * non-Default profile. Auth files are re-synced on every call so fresh logins
 * from the user's own browsing show up. `srcDir` is injectable for tests.
 */
export function snapshotRealProfile(
  browser: ChromiumBrowser,
  storeDir: string,
  srcDir?: string,
): { ok: true; dir: string } | { ok: false; reason: string } {
  const src = srcDir ?? realProfileDataDir(browser)
  if (!src || !existsSync(src)) {
    return {
      ok: false,
      reason:
        `profile directory for "${browser}" was not found. ` +
        'Launch that browser at least once, or turn browser.use_real_profile off.',
    }
  }
  const dst = join(storeDir, browser)
  const sourceProfile = lastUsedProfile(src)
  const marker = join(dst, SNAPSHOT_DONE_MARKER)
  // Only a copy that previously COMPLETED counts as populated: a torn first
  // copy (disk full, Ctrl+C) is rebuilt from scratch, not auth-overlaid.
  const populated = existsSync(marker)
  try {
    mkdirSync(dst, { recursive: true })
    // The snapshot holds copies of Cookies / Login Data — it is a credential
    // store, so owner-only permissions on both the store and the copy.
    chmodSync(storeDir, 0o700)
    chmodSync(dst, 0o700)

    const localState = join(src, 'Local State')
    if (existsSync(localState)) {
      copyFileSync(localState, join(dst, 'Local State'))
    }

    let treeCopied = populated
    if (!populated) {
      const dstDefault = join(dst, 'Default')
      rmSync(dstDefault, { recursive: true, force: true })
      try {
        cpSync(join(src, sourceProfile), dstDefault, {
          recursive: true,
          force: true,
          filter: (from) => !isIgnored(basename(from)),
        })
        treeCopied = true
      } catch (error) {
        // Per-file failures (browser mid-write) are tolerated: the auth
        // overlay below is what actually signs the session in. No marker is
        // written, so the tree is retried next launch.
        log.warn('browser', `real-profile snapshot: partial profile copy from ${src}:`, error)
      }
    }

    const failedDbs = mirrorProfileAuth(src, dst, sourceProfile)
    if (failedDbs > 0) {
      // Could not read the user's cookie/login DBs at all. Fail closed rather
      // than launch a silently signed-out session.
      return {
        ok: false,
        reason:
          `could not read the "${browser}" profile's login data (${failedDbs} database(s) ` +
          `unreadable). Close ${browser} and retry, or turn browser.use_real_profile off.`,
      }
    }

    // Never carry live-instance leftovers into the copy.
    for (const leftover of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      rmSync(join(dst, leftover), { force: true })
    }
    if (treeCopied && !populated) {
      writeFileSync(marker, sourceProfile, 'utf8')
    }
  } catch (error) {
    const message = errorMessage(error)
    return { ok: false, reason: `could not snapshot the "${browser}" profile: ${message}` }
  }
  return { ok: true, dir: dst }
}

/**
 * Delete the whole snapshot store (all copied credentials). Called when the
 * consent toggle is off, so copied Cookies / Login Data don't outlive it.
 */
export function cleanupRealProfileStore(storeDir: string): void {
  try {
    if (existsSync(storeDir)) {
      rmSync(storeDir, { recursive: true, force: true })
      log.info('browser', `Removed real-profile snapshot store ${storeDir} (consent off)`)
    }
  } catch (error) {
    log.debug('browser', `real-profile cleanup failed for ${storeDir}:`, error)
  }
}

/**
 * Resolve everything needed to launch a consented real-profile session:
 * detect the default Chromium browser, snapshot its active profile, and
 * locate the real browser binary to drive the copy with.
 */
export function prepareRealProfile(
  storeDir: string,
  executableOverride?: string,
): RealProfileResult {
  const detected = detectDefaultChromium()
  if (!detected.ok) {
    return { ok: false, reason: detected.reason }
  }
  const executablePath = executableOverride ?? findBrowserExecutable(detected.browser)
  if (!executablePath || !existsSync(executablePath)) {
    return {
      ok: false,
      reason:
        `could not find the ${detected.browser} executable` +
        (executableOverride ? ` at "${executableOverride}"` : '') +
        '. Set browser.executable_path in egirl.toml.',
    }
  }
  const snapshot = snapshotRealProfile(detected.browser, storeDir)
  if (!snapshot.ok) {
    return { ok: false, reason: snapshot.reason }
  }
  return { ok: true, userDataDir: snapshot.dir, executablePath }
}
