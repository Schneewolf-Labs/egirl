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
    complexity?: 'local' | 'remote' | 'auto'
    /**
     * Register this skill as a slash command. `/name args` runs a turn with the skill's
     * instructions and the arguments, so a command is discoverability and a permission gate
     * over natural language, never a bypass of the model. An agent that writes a SKILL.md
     * with this block (via /learn, say) has registered a command.
     */
    command?: {
      /** Defaults to the skill name, slugged. Built-in commands always win. */
      name?: string
      /** One line for /help and the Discord picker. Defaults to the skill description. */
      description?: string
      /** What the arguments mean, e.g. "what to draw". Absent means the command takes none. */
      args?: string
      /** Who may run it. `allowed` = the channel's allowed users; `owner` = the owner list. */
      permission?: 'everyone' | 'allowed' | 'owner'
    }
  }
}

export interface Skill {
  name: string
  description: string
  content: string // Full SKILL.md content after frontmatter
  metadata: SkillMetadata
  baseDir: string
  enabled: boolean
}
