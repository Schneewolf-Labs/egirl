import { Type, Static } from '@sinclair/typebox'

export const EgirlConfigSchema = Type.Object({
  // Workspace
  workspace: Type.String({ default: '~/.egirl/workspace' }),

  // Local model configuration
  local: Type.Object({
    provider: Type.Union([
      Type.Literal('llamacpp'),
      Type.Literal('ollama'),
      Type.Literal('vllm')
    ]),
    endpoint: Type.String(),
    model: Type.String(),
    contextLength: Type.Number({ default: 8192 }),
    confidenceEstimation: Type.Boolean({ default: true }),
  }),

  // Remote model configuration
  remote: Type.Object({
    anthropic: Type.Optional(Type.Object({
      apiKey: Type.String(),
      defaultModel: Type.String({ default: 'claude-sonnet-4-20250514' }),
    })),
    openai: Type.Optional(Type.Object({
      apiKey: Type.String(),
      defaultModel: Type.String({ default: 'gpt-4o' }),
    })),
  }),

  // Routing rules
  routing: Type.Object({
    defaultModel: Type.Union([Type.Literal('local'), Type.Literal('remote')], { default: 'local' }),
    escalationThreshold: Type.Number({ default: 0.4 }),
    alwaysLocal: Type.Array(Type.String(), { default: ['memory_search', 'memory_get'] }),
    alwaysRemote: Type.Array(Type.String(), { default: ['code_generation', 'code_review'] }),
  }),

  // Channels
  channels: Type.Object({
    discord: Type.Optional(Type.Object({
      token: Type.String(),
      allowedUsers: Type.Array(Type.String()),
    })),
  }),

  // Skills directories
  skills: Type.Object({
    directories: Type.Array(Type.String(), {
      default: ['~/.egirl/skills', '{workspace}/skills']
    }),
  }),
})

export type EgirlConfig = Static<typeof EgirlConfigSchema>
