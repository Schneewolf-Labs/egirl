import { describe, test, expect } from 'bun:test'
import { isPathAllowed, isSensitivePath, getDefaultSensitivePatterns } from '../../src/safety/path-guard'

describe('path-guard', () => {
  describe('isPathAllowed', () => {
    const cwd = '/home/user/project'
    const allowedPaths = ['/home/user/project', '/tmp']

    test('allows paths within allowed directories', () => {
      expect(isPathAllowed('/home/user/project/src/index.ts', cwd, allowedPaths)).toBeUndefined()
      expect(isPathAllowed('/tmp/output.txt', cwd, allowedPaths)).toBeUndefined()
      expect(isPathAllowed('src/index.ts', cwd, allowedPaths)).toBeUndefined()
    })

    test('blocks paths outside allowed directories', () => {
      expect(isPathAllowed('/etc/passwd', cwd, allowedPaths)).toBeDefined()
      expect(isPathAllowed('/home/other/file.txt', cwd, allowedPaths)).toBeDefined()
      expect(isPathAllowed('/var/log/syslog', cwd, allowedPaths)).toBeDefined()
    })

    test('no restriction when allowedPaths is empty', () => {
      expect(isPathAllowed('/etc/passwd', cwd, [])).toBeUndefined()
      expect(isPathAllowed('/anywhere/at/all', cwd, [])).toBeUndefined()
    })

    test('prevents path traversal via prefix matching', () => {
      // /home/user/project-evil should NOT match /home/user/project
      expect(isPathAllowed('/home/user/project-evil/file.txt', cwd, allowedPaths)).toBeDefined()
    })
  })

  describe('isSensitivePath', () => {
    const cwd = '/home/user/project'
    const patterns = getDefaultSensitivePatterns()

    test('blocks sensitive files', () => {
      const sensitive = [
        '.env',
        '.env.production',
        '/home/user/.ssh/id_rsa',
        '/home/user/.ssh/id_ed25519',
        '/home/user/.ssh/id_ecdsa',
        'certs/server.pem',
        'certs/server.key',
        '/home/user/.ssh/config',
        '/home/user/.npmrc',
        '/home/user/.pypirc',
        'service-account/credentials.json',
        '/home/user/.git-credentials',
        '/home/user/.aws/credentials',
        '/home/user/.docker/config.json',
      ]

      for (const path of sensitive) {
        expect(isSensitivePath(path, cwd, patterns)).toBeDefined()
      }
    })

    test('allows normal files', () => {
      const normal = [
        'src/index.ts',
        'README.md',
        'package.json',
        'tsconfig.json',
        '.gitignore',
        'config/settings.toml',
        'environment.ts',
      ]

      for (const path of normal) {
        expect(isSensitivePath(path, cwd, patterns)).toBeUndefined()
      }
    })
  })
})
