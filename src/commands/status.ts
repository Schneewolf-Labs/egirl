import type { RuntimeConfig } from '../config'
import { createProviderRegistry } from '../providers'
import { createSkillManager } from '../skills'
import { BOLD, colors, DIM, getTheme, RESET } from '../ui/theme'

export async function showStatus(config: RuntimeConfig): Promise<void> {
  const c = colors()
  const theme = getTheme()

  console.log(`\n${c.secondary}${BOLD}egirl${RESET} ${DIM}Status${RESET}\n`)

  console.log(`${c.primary}Configuration${RESET}`)
  console.log(`  ${DIM}Workspace${RESET}   ${config.workspace.path}`)
  console.log(
    `  ${DIM}Theme${RESET}       ${c.accent}${theme.name}${RESET} ${DIM}(${theme.label})${RESET}`,
  )
  console.log(`  ${DIM}Local Model${RESET} ${config.local.model}`)
  console.log(`  ${DIM}Endpoint${RESET}    ${config.local.endpoint}`)

  if (config.remote.anthropic) {
    console.log(`  ${DIM}Anthropic${RESET}   ${config.remote.anthropic.model}`)
  }
  if (config.remote.openai) {
    console.log(`  ${DIM}OpenAI${RESET}      ${config.remote.openai.model}`)
  }

  if (config.local.embeddings) {
    console.log(
      `  ${DIM}Embeddings${RESET}  ${config.local.embeddings.model} ${DIM}@ ${config.local.embeddings.endpoint}${RESET}`,
    )
    console.log(
      `              ${DIM}${config.local.embeddings.dimensions}d, multimodal=${config.local.embeddings.multimodal}${RESET}`,
    )
  }

  // Show loaded skills
  const skillManager = createSkillManager()
  try {
    await skillManager.loadFromDirectories(config.skills.dirs)
  } catch {
    /* already logged */
  }
  const skills = skillManager.getAll()
  console.log(`\n${c.primary}Skills${RESET} ${DIM}(${skills.length} loaded)${RESET}`)
  for (const skill of skills) {
    const emoji = skill.metadata.openclaw?.emoji ?? ''
    const complexity = skill.metadata.egirl?.complexity ?? 'auto'
    const status = skill.enabled ? `${c.success}enabled${RESET}` : `${c.muted}disabled${RESET}`
    console.log(
      `  ${emoji ? `${emoji} ` : ''}${skill.name} ${DIM}[${complexity}]${RESET} ${status}`,
    )
  }

  console.log(`\n${c.primary}Routing${RESET}`)
  console.log(`  ${DIM}Default${RESET}     ${config.routing.default}`)
  console.log(`  ${DIM}Threshold${RESET}   ${config.routing.escalationThreshold}`)
  console.log(`  ${DIM}Local${RESET}       ${config.routing.alwaysLocal.join(', ')}`)
  console.log(`  ${DIM}Remote${RESET}      ${config.routing.alwaysRemote.join(', ')}`)

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
    const message = error instanceof Error ? error.message : String(error)
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
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  ${DIM}Embeddings${RESET}  ${c.error}Error${RESET} ${DIM}${message}${RESET}`)
    }
  }

  console.log()
}
