import { describe, test, expect } from 'bun:test'
import { parseSkillMarkdown, extractSkillName, extractSkillDescription } from '../../src/skills/parser'

describe('parseSkillMarkdown', () => {
  test('parses frontmatter and content', () => {
    const md = `---
openclaw:
  requires:
    bins: ["git"]
  emoji: "🔀"
egirl:
  complexity: "remote"
  canEscalate: true
---

# Git Operations

Instructions for git operations.`

    const result = parseSkillMarkdown(md)

    expect(result.metadata.openclaw?.requires?.bins).toEqual(['git'])
    expect(result.metadata.openclaw?.emoji).toBe('🔀')
    expect(result.metadata.egirl?.complexity).toBe('remote')
    expect(result.metadata.egirl?.canEscalate).toBe(true)
    expect(result.content).toContain('# Git Operations')
    expect(result.content).toContain('Instructions for git operations.')
  })

  test('returns empty metadata when no frontmatter', () => {
    const md = `# Simple Skill

Just some instructions.`

    const result = parseSkillMarkdown(md)

    expect(result.metadata).toEqual({})
    expect(result.content).toBe('# Simple Skill\n\nJust some instructions.')
  })

  test('handles frontmatter with only egirl extensions', () => {
    const md = `---
egirl:
  complexity: "local"
  escalationTriggers: ["error", "timeout"]
---

# Local Skill

Does stuff locally.`

    const result = parseSkillMarkdown(md)

    expect(result.metadata.egirl?.complexity).toBe('local')
    expect(result.metadata.egirl?.escalationTriggers).toEqual(['error', 'timeout'])
    expect(result.metadata.openclaw).toBeUndefined()
  })

  test('handles empty frontmatter gracefully', () => {
    // When frontmatter delimiters have no content between them,
    // the regex doesn't match (requires at least a newline), so
    // the parser treats the whole thing as content
    const md = `---
---

# Empty Frontmatter`

    const result = parseSkillMarkdown(md)

    // Falls through to no-frontmatter path
    expect(result.content).toContain('# Empty Frontmatter')
  })

  test('trims whitespace from content', () => {
    const md = `---
egirl:
  complexity: "auto"
---

  # Padded Skill

  Some content with spaces.
`

    const result = parseSkillMarkdown(md)

    expect(result.content).toContain('# Padded Skill')
    expect(result.content).toContain('Some content with spaces.')
    // Content should be trimmed (no leading/trailing whitespace)
    expect(result.content).toBe(result.content.trim())
  })
})

describe('extractSkillName', () => {
  test('extracts name from first heading', () => {
    const name = extractSkillName('# Code Review\n\nReview code changes.')
    expect(name).toBe('Code Review')
  })

  test('extracts name from h1 with surrounding content', () => {
    const name = extractSkillName('Some preamble\n# My Skill\n\nDescription.')
    expect(name).toBe('My Skill')
  })

  test('falls back to first line when no heading', () => {
    const name = extractSkillName('This is a skill without a heading\n\nMore content.')
    expect(name).toBe('This is a skill without a heading')
  })

  test('returns empty string for empty content', () => {
    const name = extractSkillName('')
    // Empty input yields empty first line, ?? doesn't trigger for ''
    expect(name).toBe('')
  })

  test('trims whitespace from heading', () => {
    const name = extractSkillName('#   Spaced Heading   \n\nContent.')
    expect(name).toBe('Spaced Heading')
  })
})

describe('extractSkillDescription', () => {
  test('extracts first paragraph after heading', () => {
    const desc = extractSkillDescription('# Code Review\n\nReview code changes for quality and bugs.')
    expect(desc).toBe('Review code changes for quality and bugs.')
  })

  test('skips blank lines between heading and description', () => {
    const desc = extractSkillDescription('# Skill\n\n\n\nThe description is here.')
    expect(desc).toBe('The description is here.')
  })

  test('returns empty string when no content after heading', () => {
    const desc = extractSkillDescription('# Heading Only')
    expect(desc).toBe('')
  })

  test('returns empty string when no heading exists', () => {
    const desc = extractSkillDescription('Just some text without a heading.')
    expect(desc).toBe('')
  })

  test('stops at the first non-empty line after heading', () => {
    const desc = extractSkillDescription('# Skill\n\nFirst line.\nSecond line.')
    expect(desc).toBe('First line.')
  })
})
