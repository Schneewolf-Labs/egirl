import { mkdir, writeFile, access, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { log } from '../util/logger'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, 'templates')

const WORKSPACE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'MEMORY.md',
]

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function bootstrapWorkspace(workspaceDir: string): Promise<void> {
  log.info('workspace', `Bootstrapping workspace at ${workspaceDir}`)

  // Create workspace directory
  await mkdir(workspaceDir, { recursive: true })

  // Create subdirectories
  const subdirs = ['skills', 'logs', 'sessions']
  for (const subdir of subdirs) {
    await mkdir(join(workspaceDir, subdir), { recursive: true })
  }

  // Copy template files if they don't exist
  for (const filename of WORKSPACE_FILES) {
    const targetPath = join(workspaceDir, filename)

    if (await fileExists(targetPath)) {
      log.debug('workspace', `File already exists: ${filename}`)
      continue
    }

    try {
      const templatePath = join(TEMPLATES_DIR, filename)
      const content = await readFile(templatePath, 'utf-8')
      await writeFile(targetPath, content, 'utf-8')
      log.info('workspace', `Created: ${filename}`)
    } catch (error) {
      log.warn('workspace', `Failed to create ${filename}:`, error)
    }
  }

  log.info('workspace', 'Workspace bootstrap complete')
}
