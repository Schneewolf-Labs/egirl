export { loadSkillsFromDirectories, loadSkillsFromDirectory } from './loader'
export { extractSkillDescription, extractSkillName, parseSkillMarkdown } from './parser'
export type { Skill, SkillMatch, SkillMetadata } from './types'

import { log } from '../util/logger'
import { loadSkillsFromDirectories } from './loader'
import type { Skill } from './types'

export class SkillManager {
  private skills: Map<string, Skill> = new Map()

  async loadFromDirectories(directories: string[]): Promise<void> {
    const skills = await loadSkillsFromDirectories(directories)

    for (const skill of skills) {
      this.skills.set(skill.name.toLowerCase(), skill)
    }

    log.info('skills', `Loaded ${this.skills.size} skills`)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name.toLowerCase())
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  getEnabled(): Skill[] {
    return this.getAll().filter((s) => s.enabled)
  }

  enable(name: string): boolean {
    const skill = this.get(name)
    if (skill) {
      skill.enabled = true
      return true
    }
    return false
  }

  disable(name: string): boolean {
    const skill = this.get(name)
    if (skill) {
      skill.enabled = false
      return true
    }
    return false
  }
}

export function createSkillManager(): SkillManager {
  return new SkillManager()
}
