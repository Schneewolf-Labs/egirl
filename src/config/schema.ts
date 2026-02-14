import { Type, Static } from '@sinclair/typebox'

export const EgirlConfigSchema = Type.Object({
  workspace: Type.Object({
    path: Type.String({ default: '~/.egirl/workspace' }),
  }),

  local: Type.Object({
    endpoint: Type.String({ default: 'http://localhost:8080' }),
    model: Type.String({ default: 'qwen2.5-32b-instruct' }),
    context_length: Type.Number({ default: 32768 }),
    max_concurrent: Type.Number({ default: 2 }),
    embeddings: Type.Optional(Type.Object({
      endpoint: Type.String({ default: 'http://localhost:8082' }),
      model: Type.String({ default: 'qwen3-vl-embedding-2b' }),
      dimensions: Type.Number({ default: 2048 }),
      multimodal: Type.Boolean({ default: true }),
    })),
  }),

  routing: Type.Object({
    default: Type.Union([Type.Literal('local'), Type.Literal('remote')], { default: 'local' }),
    escalation_threshold: Type.Number({ default: 0.4 }),
    always_local: Type.Array(Type.String(), { default: ['memory_search', 'memory_get', 'greeting', 'acknowledgment'] }),
    always_remote: Type.Array(Type.String(), { default: ['code_generation', 'code_review', 'complex_reasoning'] }),
  }),

  channels: Type.Optional(Type.Object({
    discord: Type.Optional(Type.Object({
      allowed_channels: Type.Array(Type.String(), { default: ['dm'] }),
      allowed_users: Type.Array(Type.String(), { default: [] }),
    })),
    claude_code: Type.Optional(Type.Object({
      permission_mode: Type.Union([
        Type.Literal('default'),
        Type.Literal('acceptEdits'),
        Type.Literal('bypassPermissions'),
        Type.Literal('plan'),
      ], { default: 'bypassPermissions' }),
      model: Type.Optional(Type.String()),
      working_dir: Type.Optional(Type.String()),
      max_turns: Type.Optional(Type.Number()),
    })),
    xmpp: Type.Optional(Type.Object({
      service: Type.String({ default: 'xmpp://localhost:5222' }),
      domain: Type.Optional(Type.String()),
      resource: Type.Optional(Type.String()),
      allowed_jids: Type.Array(Type.String(), { default: [] }),
    })),
    api: Type.Optional(Type.Object({
      port: Type.Number({ default: 3000 }),
      host: Type.String({ default: '127.0.0.1' }),
    })),
  })),

  skills: Type.Object({
    dirs: Type.Array(Type.String(), { default: ['~/.egirl/skills', '{workspace}/skills'] }),
  }),
})

export type EgirlConfig = Static<typeof EgirlConfigSchema>

// Runtime config with resolved paths and secrets from .env
export interface RuntimeConfig {
  workspace: {
    path: string
  }
  local: {
    endpoint: string
    model: string
    contextLength: number
    maxConcurrent: number
    embeddings?: {
      endpoint: string
      model: string
      dimensions: number
      multimodal: boolean
    }
  }
  remote: {
    anthropic?: {
      apiKey: string
      model: string
    }
    openai?: {
      apiKey: string
      model: string
      baseUrl?: string
    }
  }
  routing: {
    default: 'local' | 'remote'
    escalationThreshold: number
    alwaysLocal: string[]
    alwaysRemote: string[]
  }
  channels: {
    discord?: {
      token: string
      allowedChannels: string[]
      allowedUsers: string[]
    }
    claudeCode?: {
      permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
      model?: string
      workingDir: string
      maxTurns?: number
    }
    xmpp?: {
      service: string
      domain: string
      username: string
      password: string
      resource?: string
      allowedJids: string[]
    }
    api?: {
      port: number
      host: string
    }
  }
  skills: {
    dirs: string[]
  }
}
