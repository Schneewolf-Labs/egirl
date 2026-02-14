import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { log } from '../util/logger'
import { extractSkillDescription, extractSkillName, parseSkillMarkdown } from './parser'
import type { Skill } from './types'

const SKILL_FILENAME = 'SKILL.md'

export async function loadSkillsFromDirectory(directory: string): Promise<Skill[]> {
  const skills: Skill[] = []

  try {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillPath = join(directory, entry.name, SKILL_FILENAME)

      try {
        const stats = await stat(skillPath)
        if (!stats.isFile()) continue

        const content = await readFile(skillPath, 'utf-8')
        const parsed = parseSkillMarkdown(content)

        const skill: Skill = {
          name: extractSkillName(parsed.content) || entry.name,
          description: extractSkillDescription(parsed.content),
          content: parsed.content,
          metadata: parsed.metadata,
          baseDir: join(directory, entry.name),
          enabled: true,
        }

        skills.push(skill)
        log.debug('skills', `Loaded skill: ${skill.name} from ${skillPath}`)
      } catch {
        // No SKILL.md or couldn't read it, skip
      }
    }
  } catch (error) {
    log.warn('skills', `Failed to read skills directory: ${directory}`, error)
  }

  return skills
}

export async function loadSkillsFromDirectories(directories: string[]): Promise<Skill[]> {
  const allSkills: Skill[] = []

  for (const dir of directories) {
    const skills = await loadSkillsFromDirectory(dir)
    allSkills.push(...skills)
  }

  // Deduplicate by name (later directories override earlier)
  const skillMap = new Map<string, Skill>()
  for (const skill of allSkills) {
    skillMap.set(skill.name, skill)
  }

  return Array.from(skillMap.values())
}
