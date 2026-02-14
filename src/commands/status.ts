import type { RuntimeConfig } from '../config'
import { createProviderRegistry } from '../providers'
import { createSkillManager } from '../skills'

export async function showStatus(config: RuntimeConfig): Promise<void> {
  console.log('egirl Status\n')

  console.log('Configuration:')
  console.log(`  Workspace: ${config.workspace.path}`)
  console.log(`  Local Model: ${config.local.model}`)
  console.log(`  Local Endpoint: ${config.local.endpoint}`)

  if (config.remote.anthropic) {
    console.log(`  Remote (Anthropic): ${config.remote.anthropic.model}`)
  }
  if (config.remote.openai) {
    console.log(`  Remote (OpenAI): ${config.remote.openai.model}`)
  }

  if (config.local.embeddings) {
    console.log(
      `  Embeddings: ${config.local.embeddings.model} @ ${config.local.embeddings.endpoint}`,
    )
    console.log(
      `    Dimensions: ${config.local.embeddings.dimensions}, Multimodal: ${config.local.embeddings.multimodal}`,
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
  console.log(`\nSkills: ${skills.length} loaded`)
  for (const skill of skills) {
    const emoji = skill.metadata.openclaw?.emoji ?? ''
    const complexity = skill.metadata.egirl?.complexity ?? 'auto'
    const status = skill.enabled ? 'enabled' : 'disabled'
    console.log(`  ${emoji ? `${emoji} ` : ''}${skill.name} [${complexity}] (${status})`)
  }

  console.log(`\nRouting:`)
  console.log(`  Default: ${config.routing.default}`)
  console.log(`  Escalation Threshold: ${config.routing.escalationThreshold}`)
  console.log(`  Always Local: ${config.routing.alwaysLocal.join(', ')}`)
  console.log(`  Always Remote: ${config.routing.alwaysRemote.join(', ')}`)

  // Test local provider connection
  console.log('\nProvider Status:')
  try {
    const providers = createProviderRegistry(config)
    const testResponse = await providers.local.chat({
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    })
    console.log(`  Local: Connected (${testResponse.model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  Local: Error - ${message}`)
  }

  // Test embeddings service
  if (config.local.embeddings) {
    try {
      const response = await fetch(`${config.local.embeddings.endpoint}/health`)
      if (response.ok) {
        const health = (await response.json()) as { status: string; device: string }
        console.log(`  Embeddings: Connected (${health.device})`)
      } else {
        console.log(`  Embeddings: Error - ${response.status}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  Embeddings: Error - ${message}`)
    }
  }
}
