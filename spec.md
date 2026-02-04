# egirl - Local-First AI Agent Framework

## Project Overview

egirl is a personal AI agent framework that uses a local LLM for decision-making and task routing, escalating to larger cloud models (Claude, GPT) only when necessary for complex tasks like code generation. It maintains compatibility with OpenClaw's skill format and workspace structure while having a distinct hybrid execution model.

## Key Design Principles

1. **Local-First**: The local LLM handles routing decisions, memory operations, simple conversations, and task decomposition - we never pay API costs for these
2. **Smart Escalation**: Complex tasks (code generation, deep reasoning) automatically escalate to cloud models
3. **OpenClaw Compatible**: Skills, workspace structure, and session format are compatible with OpenClaw ecosystem
4. **Cost Aware**: Track savings from local execution vs what cloud would have cost

## Tech Stack

- **Runtime**: Bun (for speed, TypeScript native)
- **Local LLM**: llama.cpp server / Ollama / vLLM (configurable)
- **Remote LLMs**: Anthropic Claude, OpenAI (via official SDKs)
- **Database**: SQLite (via better-sqlite3 or bun:sqlite) for memory indexing
- **Embeddings**: Local (nomic-embed-text via Ollama) or fallback to cloud

## Directory Structure
```
egirl/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── README.md
├── .env.example
│
├── src/
│   ├── index.ts                 # Main entry point
│   ├── config/
│   │   ├── index.ts             # Config loader
│   │   ├── schema.ts            # Config schema (TypeBox)
│   │   └── defaults.ts          # Default configuration
│   │
│   ├── gateway/
│   │   ├── index.ts             # WebSocket server
│   │   ├── protocol.ts          # Message types and handlers
│   │   └── session.ts           # Session management
│   │
│   ├── routing/
│   │   ├── index.ts             # Main router export
│   │   ├── model-router.ts      # Decides local vs remote
│   │   ├── escalation.ts        # Escalation detection and handling
│   │   ├── heuristics.ts        # Fast routing rules (no LLM needed)
│   │   └── rules.ts             # Configurable routing rules
│   │
│   ├── agent/
│   │   ├── index.ts             # Agent export
│   │   ├── loop.ts              # Hybrid agent loop
│   │   ├── context.ts           # Context building (system prompts)
│   │   └── streaming.ts         # Response streaming
│   │
│   ├── providers/
│   │   ├── index.ts             # Provider registry
│   │   ├── types.ts             # Shared interfaces
│   │   ├── local/
│   │   │   ├── index.ts         # Local provider factory
│   │   │   ├── llamacpp.ts      # llama.cpp server client
│   │   │   ├── ollama.ts        # Ollama client
│   │   │   └── vllm.ts          # vLLM client
│   │   └── remote/
│   │       ├── index.ts         # Remote provider factory
│   │       ├── anthropic.ts     # Claude client
│   │       └── openai.ts        # OpenAI client
│   │
│   ├── tools/
│   │   ├── index.ts             # Tool registry
│   │   ├── types.ts             # Tool interfaces
│   │   ├── executor.ts          # Tool execution engine
│   │   ├── builtin/
│   │   │   ├── read.ts          # Read file
│   │   │   ├── write.ts         # Write file
│   │   │   ├── edit.ts          # Edit file (str_replace style)
│   │   │   ├── exec.ts          # Execute commands
│   │   │   ├── glob.ts          # File globbing
│   │   │   └── memory.ts        # Memory search/get tools
│   │   └── loader.ts            # Dynamic tool loading
│   │
│   ├── skills/
│   │   ├── index.ts             # Skill manager
│   │   ├── loader.ts            # Load skills from directories
│   │   ├── parser.ts            # Parse SKILL.md frontmatter
│   │   ├── types.ts             # Skill interfaces (OpenClaw compatible)
│   │   └── bundled/             # Bundled skills
│   │       └── .gitkeep
│   │
│   ├── memory/
│   │   ├── index.ts             # Memory manager
│   │   ├── files.ts             # MEMORY.md and daily logs
│   │   ├── indexer.ts           # SQLite FTS + vector indexing
│   │   ├── search.ts            # Hybrid search (BM25 + vector)
│   │   └── embeddings.ts        # Local/remote embedding provider
│   │
│   ├── workspace/
│   │   ├── index.ts             # Workspace manager
│   │   ├── bootstrap.ts         # Initialize workspace files
│   │   └── templates/           # Default file templates
│   │       ├── AGENTS.md
│   │       ├── SOUL.md
│   │       ├── TOOLS.md
│   │       ├── IDENTITY.md
│   │       ├── USER.md
│   │       └── MEMORY.md
│   │
│   ├── channels/
│   │   ├── index.ts             # Channel registry
│   │   ├── types.ts             # Channel interfaces
│   │   ├── discord.ts           # Discord bot (discord.js)
│   │   └── cli.ts               # Local CLI channel for testing
│   │
│   ├── tracking/
│   │   ├── index.ts             # Usage tracker
│   │   ├── costs.ts             # Cost calculation
│   │   └── stats.ts             # Statistics and reporting
│   │
│   └── utils/
│       ├── logger.ts            # Structured logging
│       ├── tokens.ts            # Token counting
│       └── async.ts             # Async utilities
│
├── test/
│   ├── routing/
│   │   └── model-router.test.ts
│   ├── tools/
│   │   └── executor.test.ts
│   └── fixtures/
│       └── skills/
│
└── workspace/                    # Default workspace (gitignored except templates)
    └── .gitkeep
```

## Core Interfaces to Implement

### Config Schema (src/config/schema.ts)
```typescript
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
```

### Provider Interface (src/providers/types.ts)
```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: {
    inputTokens: number
    outputTokens: number
  }
  // egirl extensions
  confidence?: number  // 0-1, only from local with confidence estimation
  model: string
  provider: 'local' | 'remote'
}

export interface LLMProvider {
  name: string
  type: 'local' | 'remote'
  chat(request: ChatRequest): Promise<ChatResponse>
  chatStream?(request: ChatRequest): AsyncIterable<ChatStreamChunk>
}
```

### Routing Decision (src/routing/model-router.ts)
```typescript
export interface RoutingDecision {
  model: 'local' | 'remote'
  provider?: string  // e.g., 'anthropic/claude-sonnet-4'
  reason: string
  confidence: number
}

export interface TaskAnalysis {
  type: 'conversation' | 'tool_use' | 'code_generation' | 'reasoning' | 'memory_op'
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex'
  estimatedTokens: number
  skillsInvolved: string[]
}
```

### Skill Interface (src/skills/types.ts) - OpenClaw Compatible
```typescript
export interface SkillMetadata {
  // OpenClaw compatible fields
  openclaw?: {
    requires?: {
      bins?: string[]
      env?: string[]
      config?: string[]
    }
    primaryEnv?: string
    emoji?: string
    homepage?: string
  }
  // egirl extensions
  egirl?: {
    complexity: 'local' | 'remote' | 'auto'
    canEscalate?: boolean
    escalationTriggers?: string[]
    preferredProvider?: string
  }
}

export interface Skill {
  name: string
  description: string
  content: string  // Full SKILL.md content after frontmatter
  metadata: SkillMetadata
  baseDir: string
  enabled: boolean
}
```

### Tool Interface (src/tools/types.ts)
```typescript
export interface ToolDefinition {
  name: string
  description: string
  parameters: JSONSchema
}

export interface ToolContext {
  workspaceDir: string
  sessionId: string
  currentModel: 'local' | 'remote'
}

export interface ToolResult {
  success: boolean
  output: string
  // egirl extensions
  suggestEscalation?: boolean
  escalationReason?: string
}

export interface Tool {
  definition: ToolDefinition
  execute(params: unknown, context: ToolContext): Promise<ToolResult>
}
```

## Initial Implementation Tasks

1. **Set up the project structure** with all directories and stub files
2. **Implement config loading** with TypeBox validation and .env support
3. **Implement the local LLM provider** (start with Ollama as it's easiest)
4. **Implement basic tools** (read, write, exec)
5. **Implement the skill loader** (parse SKILL.md with YAML frontmatter)
6. **Implement the model router** with heuristics (no LLM analysis yet)
7. **Implement the basic agent loop** (single turn, no streaming)
8. **Implement the CLI channel** for testing
9. **Add the memory system** (file-based, no indexing yet)

## Files to Create First

Start with these files to get a working skeleton:

1. `package.json` - dependencies: `@sinclair/typebox`, `@anthropic-ai/sdk`, `openai`, `yaml`, `better-sqlite3`
2. `src/index.ts` - entry point that loads config and starts gateway
3. `src/config/index.ts` - config loader
4. `src/providers/local/ollama.ts` - Ollama client
5. `src/providers/remote/anthropic.ts` - Claude client  
6. `src/tools/builtin/exec.ts` - command execution
7. `src/routing/model-router.ts` - routing logic
8. `src/agent/loop.ts` - main agent loop
9. `src/channels/cli.ts` - CLI for testing

## Environment Variables
```bash
# .env.example
EGIRL_WORKSPACE=~/.egirl/workspace

# Local model
EGIRL_LOCAL_PROVIDER=ollama
EGIRL_LOCAL_ENDPOINT=http://localhost:11434
EGIRL_LOCAL_MODEL=qwen2.5:32b

# Remote models (optional - only if you want escalation)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Channels
DISCORD_BOT_TOKEN=...
```

## Commands
```bash
# Development
bun run dev          # Start with hot reload
bun run build        # Build for production
bun test             # Run tests

# CLI
bun run egirl chat   # Interactive CLI chat
bun run egirl status # Show current config and stats
```

## Notes

- Use Bun's native SQLite for any database needs
- Prefer streaming responses where possible
- Log all routing decisions for debugging
- Track token usage and costs from the start
- Keep OpenClaw compatibility in mind - don't break skill format

Start by creating the project structure and implementing a minimal working version that can:
1. Load config
2. Connect to Ollama
3. Route a simple message to local
4. Return a response via CLI

Then iterate from there.
