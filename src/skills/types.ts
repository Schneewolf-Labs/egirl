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

export interface SkillMatch {
  skill: Skill
  confidence: number
  reason: string
}
