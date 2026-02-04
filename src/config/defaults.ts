import type { EgirlConfig } from './schema'

export const defaultConfig: EgirlConfig = {
  workspace: '~/.egirl/workspace',

  local: {
    provider: 'llamacpp',
    endpoint: 'http://localhost:8080',
    model: 'default',
    contextLength: 8192,
    confidenceEstimation: true,
  },

  remote: {},

  routing: {
    defaultModel: 'local',
    escalationThreshold: 0.4,
    alwaysLocal: ['memory_search', 'memory_get'],
    alwaysRemote: ['code_generation', 'code_review'],
  },

  channels: {},

  skills: {
    directories: ['~/.egirl/skills', '{workspace}/skills'],
  },
}
