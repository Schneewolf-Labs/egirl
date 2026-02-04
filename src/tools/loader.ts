import type { Tool, ToolDefinition } from './types'
import { log } from '../utils/logger'

// Dynamic tool loading from skill directories
// For now, this is a placeholder - tools are registered programmatically

export interface ToolLoader {
  loadFromDirectory(directory: string): Promise<Tool[]>
  loadFromSkill(skillDir: string): Promise<Tool[]>
}

export function createToolLoader(): ToolLoader {
  return {
    async loadFromDirectory(_directory: string): Promise<Tool[]> {
      // TODO: Implement dynamic tool loading
      log.debug('tools', 'Dynamic tool loading not yet implemented')
      return []
    },

    async loadFromSkill(_skillDir: string): Promise<Tool[]> {
      // TODO: Load tools defined in skill's tools/ directory
      log.debug('tools', 'Skill tool loading not yet implemented')
      return []
    },
  }
}
