/**
 * Filename sanitising for the VM file drop.
 *
 * The upload directory is on the host and mounted into a sandbox, so the interesting attack runs
 * outward: a crafted filename escaping the share and landing somewhere on the host the guest was
 * never meant to reach. Every traversal shape below is one that has worked against a naive
 * implementation of exactly this.
 */

import { describe, expect, test } from 'bun:test'
import { safeName, uniqueName } from '../../services/vm/safe-name'

describe('safeName', () => {
  test('keeps an ordinary filename', () => {
    expect(safeName('report.pdf')).toBe('report.pdf')
    expect(safeName('sample_v2 (final).bin')).toBe('sample_v2 (final).bin')
  })

  test('strips posix traversal', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('/etc/shadow')).toBe('shadow')
  })

  test('strips windows traversal, which surviving a slash-only split is the classic bug', () => {
    expect(safeName('..\\..\\Windows\\System32\\evil.dll')).toBe('evil.dll')
    expect(safeName('C:\\Users\\x\\payload.exe')).toBe('payload.exe')
  })

  test('rejects names that are only traversal', () => {
    expect(safeName('..')).toBeUndefined()
    expect(safeName('.')).toBeUndefined()
    expect(safeName('../..')).toBeUndefined()
    expect(safeName('/')).toBeUndefined()
  })

  test('rejects an empty result rather than inventing a name', () => {
    // A substituted default would be an upload the user believes landed somewhere it did not.
    expect(safeName('')).toBeUndefined()
    expect(safeName('...')).toBeUndefined()
    expect(safeName('   ')).toBeUndefined()
  })

  test('drops NUL and control characters', () => {
    // A NUL can truncate the path in a lower layer, so the validated name and the opened name
    // stop being the same string.
    expect(safeName('good\u0000.sh/../../etc/passwd')).toBe('passwd')
    expect(safeName('re\u0007port.txt')).toBe('report.txt')
  })

  test('un-hides dotfiles so nothing lands invisible in the share', () => {
    expect(safeName('.bashrc')).toBe('bashrc')
    expect(safeName('.ssh')).toBe('ssh')
  })

  test('neutralises characters that are path-special on other platforms', () => {
    expect(safeName('a:b|c?.txt')).toBe('a_b_c_.txt')
  })

  test('bounds the length', () => {
    expect(safeName('x'.repeat(500))?.length).toBe(200)
  })

  test('never returns something containing a separator', () => {
    for (const input of ['../a/b', 'a\\b\\c', '/x/y', '....//....//z']) {
      const out = safeName(input)
      if (out !== undefined) {
        expect(out).not.toContain('/')
        expect(out).not.toContain('\\')
      }
    }
  })
})

describe('uniqueName', () => {
  test('leaves a free name alone', () => {
    expect(uniqueName('a.txt', () => false)).toBe('a.txt')
  })

  test('suffixes before the extension rather than after', () => {
    // "report.pdf (2)" would stop being a PDF to anything that dispatches on extension.
    expect(uniqueName('report.pdf', (c) => c === 'report.pdf')).toBe('report (2).pdf')
  })

  test('keeps counting past the first collision', () => {
    const taken = new Set(['a.bin', 'a (2).bin', 'a (3).bin'])
    expect(uniqueName('a.bin', (c) => taken.has(c))).toBe('a (4).bin')
  })

  test('handles a name with no extension', () => {
    expect(uniqueName('dump', (c) => c === 'dump')).toBe('dump (2)')
  })

  test('treats a leading dot as part of the stem', () => {
    expect(uniqueName('archive.tar.gz', (c) => c === 'archive.tar.gz')).toBe('archive.tar (2).gz')
  })
})
