import type { RuntimeConfig } from '../config'
import { createProviderRegistry } from '../providers'
import { loadSkillsFromDirectories } from '../skills'
import { BOLD, colors, DIM, getTheme, RESET } from '../ui/theme'
import { errorMessage } from '../util/errors'

export async function showStatus(config: RuntimeConfig): Promise<void> {
  const c = colors()
  const theme = getTheme()

  console.log(`\n${c.secondary}${BOLD}egirl${RESET} ${DIM}Status${RESET}\n`)

  console.log(`${c.primary}Configuration${RESET}`)
  console.log(`  ${DIM}Config${RESET}      ${config.source.path ?? 'built-in defaults'}`)
  if (config.source.instance || config.source.profile || config.source.persona) {
    console.log(
      `  ${DIM}Instance${RESET}    ${config.source.instance ?? 'default'} ${DIM}(profile=${config.source.profile ?? 'top-level'}, persona=${config.source.persona ?? 'top-level'})${RESET}`,
    )
  }
  console.log(`  ${DIM}Workspace${RESET}   ${config.workspace.path}`)
  console.log(
    `  ${DIM}Theme${RESET}       ${c.accent}${theme.name}${RESET} ${DIM}(${theme.label})${RESET}`,
  )
  console.log(`  ${DIM}Local Model${RESET} ${config.local.model}`)
  console.log(`  ${DIM}Endpoint${RESET}    ${config.local.endpoint}`)

  if (config.local.embeddings) {
    console.log(
      `  ${DIM}Embeddings${RESET}  ${config.local.embeddings.model} ${DIM}@ ${config.local.embeddings.endpoint}${RESET}`,
    )
    console.log(
      `              ${DIM}${config.local.embeddings.dimensions}d, multimodal=${config.local.embeddings.multimodal}${RESET}`,
    )
  }

  if (config.channels.codeAgent) {
    console.log(
      `  ${DIM}Code Agent${RESET} ${config.channels.codeAgent.provider ?? 'claude'} ${DIM}(${config.channels.codeAgent.permissionMode})${RESET}`,
    )
    if (config.source.codeAgentUsesClaudeCodeFallback) {
      console.log(
        `              ${c.warning}using [channels.claude_code] fallback; prefer [channels.code_agent]${RESET}`,
      )
    }
  } else {
    console.log(`  ${DIM}Code Agent${RESET} ${c.muted}not configured${RESET}`)
  }
  console.log(
    `  ${DIM}Permissions${RESET} ${config.permissionSupervisor.mode} ${DIM}(default=${config.permissionSupervisor.defaultAction})${RESET}`,
  )

  // Show loaded skills
  let skills: Awaited<ReturnType<typeof loadSkillsFromDirectories>> = []
  try {
    skills = await loadSkillsFromDirectories(config.skills.dirs)
  } catch {
    /* already logged */
  }
  console.log(`\n${c.primary}Skills${RESET} ${DIM}(${skills.length} loaded)${RESET}`)
  for (const skill of skills) {
    const emoji = skill.metadata.openclaw?.emoji ?? ''
    const complexity = skill.metadata.egirl?.complexity ?? 'auto'
    const status = skill.enabled ? `${c.success}enabled${RESET}` : `${c.muted}disabled${RESET}`
    console.log(
      `  ${emoji ? `${emoji} ` : ''}${skill.name} ${DIM}[${complexity}]${RESET} ${status}`,
    )
  }

  // Test local provider connection
  console.log(`\n${c.primary}Provider Status${RESET}`)
  try {
    const providers = createProviderRegistry(config)
    const testResponse = await providers.local.chat({
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    })
    console.log(
      `  ${DIM}Local${RESET}       ${c.success}Connected${RESET} ${DIM}(${testResponse.model})${RESET}`,
    )
  } catch (error) {
    const message = errorMessage(error)
    console.log(`  ${DIM}Local${RESET}       ${c.error}Error${RESET} ${DIM}${message}${RESET}`)
  }

  // Test embeddings service
  if (config.local.embeddings) {
    try {
      const response = await fetch(`${config.local.embeddings.endpoint}/health`)
      if (response.ok) {
        const health = (await response.json()) as { status: string; device: string }
        console.log(
          `  ${DIM}Embeddings${RESET}  ${c.success}Connected${RESET} ${DIM}(${health.device})${RESET}`,
        )
      } else {
        console.log(
          `  ${DIM}Embeddings${RESET}  ${c.error}Error${RESET} ${DIM}${response.status}${RESET}`,
        )
      }
    } catch (error) {
      const message = errorMessage(error)
      console.log(`  ${DIM}Embeddings${RESET}  ${c.error}Error${RESET} ${DIM}${message}${RESET}`)
    }
  }

  console.log()
}
