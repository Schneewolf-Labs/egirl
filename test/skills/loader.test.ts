import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { loadSkillsFromDirectories, loadSkillsFromDirectory } from '../../src/skills/loader'

const BUNDLED_DIR = join(import.meta.dir, '..', '..', 'src', 'skills', 'bundled')

describe('loadSkillsFromDirectory', () => {
  test('loads bundled skills from src/skills/bundled', async () => {
    const skills = await loadSkillsFromDirectory(BUNDLED_DIR)

    expect(skills.length).toBeGreaterThanOrEqual(2)

    const names = skills.map((s) => s.name)
    expect(names).toContain('Code Review')
    expect(names).toContain('Research')
  })

  test('loaded skills have expected fields', async () => {
    const skills = await loadSkillsFromDirectory(BUNDLED_DIR)
    const codeReview = skills.find((s) => s.name === 'Code Review')

    expect(codeReview).toBeDefined()
    expect(codeReview?.description).toBeTruthy()
    expect(codeReview?.content).toContain('## Instructions')
    expect(codeReview?.metadata.egirl?.complexity).toBe('remote')
    expect(codeReview?.metadata.openclaw?.emoji).toBe('\uD83D\uDD0D')
    expect(codeReview?.baseDir).toBe(join(BUNDLED_DIR, 'code-review'))
    expect(codeReview?.enabled).toBe(true)
  })

  test('returns empty array for nonexistent directory', async () => {
    const skills = await loadSkillsFromDirectory('/tmp/nonexistent-skills-dir')
    expect(skills).toEqual([])
  })
})

describe('loadSkillsFromDirectories', () => {
  test('deduplicates skills by name, later dirs override', async () => {
    // Loading the same directory twice should deduplicate
    const skills = await loadSkillsFromDirectories([BUNDLED_DIR, BUNDLED_DIR])

    const codeReviewCount = skills.filter((s) => s.name === 'Code Review').length
    expect(codeReviewCount).toBe(1)
  })

  test('skips nonexistent directories without failing', async () => {
    const skills = await loadSkillsFromDirectories(['/tmp/does-not-exist', BUNDLED_DIR])

    expect(skills.length).toBeGreaterThanOrEqual(2)
  })

  test('returns empty array when all directories are empty or missing', async () => {
    const skills = await loadSkillsFromDirectories([
      '/tmp/does-not-exist-1',
      '/tmp/does-not-exist-2',
    ])

    expect(skills).toEqual([])
  })
})
