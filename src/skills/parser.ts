import YAML from 'yaml'
import { log } from '../util/logger'
import type { SkillMetadata } from './types'

interface ParsedSkill {
  metadata: SkillMetadata
  content: string
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

export function parseSkillMarkdown(markdown: string): ParsedSkill {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    // No frontmatter — still a valid skill (OpenClaw only requires SKILL.md)
    return {
      metadata: {},
      content: markdown.trim(),
    }
  }

  const frontmatterStr = match[1] ?? ''
  const content = match[2] ?? ''

  let metadata: SkillMetadata = {}

  try {
    metadata = YAML.parse(frontmatterStr) ?? {}
  } catch (error) {
    log.warn('skills', `Failed to parse skill frontmatter: ${error}`)
  }

  return {
    metadata,
    content: content.trim(),
  }
}

export function extractSkillName(content: string): string {
  // Look for first heading
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch?.[1]) {
    return headingMatch[1].trim()
  }

  // Fallback to first line
  const firstLine = content.split('\n')[0]?.trim()
  return firstLine ?? 'Unnamed Skill'
}

export function extractSkillDescription(content: string): string {
  // Look for text after the first heading
  const lines = content.split('\n')
  let foundHeading = false

  for (const line of lines) {
    if (line.startsWith('#')) {
      foundHeading = true
      continue
    }

    if (foundHeading && line.trim()) {
      return line.trim()
    }
  }

  return ''
}
