import { describe, expect, test } from 'bun:test'
import { skillDirs } from '../../src/bootstrap'

describe('skillDirs', () => {
  test('bundled skills come first, so configured directories can override them', () => {
    const dirs = skillDirs({ dirs: ['/home/x/skills'] })
    expect(dirs).toHaveLength(2)
    expect(dirs[0]).toMatch(/skills[\\/]bundled$/)
    expect(dirs[1]).toBe('/home/x/skills')
  })

  test('bundled = false leaves only the configured directories', () => {
    // A stranger-facing instance (a VTuber on Discord) should not offer the operator skills'
    // slash commands (/review, /ci, /land ...) to everyone in the server.
    expect(skillDirs({ dirs: ['/home/x/skills'], bundled: false })).toEqual(['/home/x/skills'])
  })
})
