import { describe, expect, test } from 'bun:test'
import pkg from '../package.json'
import { VERSION } from '../src/version'

describe('VERSION', () => {
  test('matches package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })

  test('is a plain semver release', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
