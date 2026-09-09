/**
 * Discord application commands as a projection of the one command vocabulary.
 *
 * What a user could type as `/draw a fox` in any channel is registered with Discord so the
 * client offers it with autocomplete and a description. Registration is cosmetic: an
 * interaction is turned back into the same `/name args` text and handed to the dispatcher,
 * which is also where the permission is enforced. Discord's own permission system cannot say
 * "these user IDs", so it is not asked to.
 */
import { type Client, REST, Routes } from 'discord.js'
import type { Caller, CustomCommand } from '../session/commands'
import { log } from '../util/logger'

/** The subset of the Discord API shape this file produces; kept literal so a test can pin it. */
export interface ApplicationCommandBody {
  name: string
  description: string
  options?: { type: 3; name: 'args'; description: string; required: false }[]
}

const BUILTINS: ApplicationCommandBody[] = [
  { name: 'status', description: 'Busy or idle, context, thinking' },
  {
    name: 'think',
    description: 'Thinking level for this session',
    options: [
      { type: 3, name: 'args', description: 'on, off, default, or a level', required: false },
    ],
  },
  { name: 'context', description: 'How full the context window is' },
  { name: 'help', description: 'What the commands do' },
]

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

export function buildApplicationCommands(custom: CustomCommand[]): ApplicationCommandBody[] {
  return [
    ...BUILTINS,
    ...custom.map((c) => ({
      name: c.name,
      description: clip(c.description || c.skill, 100),
      ...(c.args
        ? {
            options: [
              {
                type: 3 as const,
                name: 'args' as const,
                description: clip(c.args, 100),
                required: false as const,
              },
            ],
          }
        : {}),
    })),
  ]
}

/** Who a Discord user is to the dispatcher. Owner implies allowed; an empty allow list allows all. */
export function callerFor(
  userId: string,
  cfg: { allowedUsers: string[]; ownerUsers: string[] },
): Caller {
  const owner = cfg.ownerUsers.includes(userId)
  return {
    userId,
    allowed: owner || cfg.allowedUsers.length === 0 || cfg.allowedUsers.includes(userId),
    owner,
  }
}

/** Overwrite the bot's global application commands. Best effort: a failure is logged, chat still works. */
export async function registerApplicationCommands(
  client: Client<true>,
  token: string,
  commands: ApplicationCommandBody[],
): Promise<void> {
  try {
    const rest = new REST({ version: '10' }).setToken(token)
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
    log.info(
      'discord',
      `Registered ${commands.length} slash commands: ${commands.map((c) => `/${c.name}`).join(' ')}`,
    )
  } catch (error) {
    log.warn('discord', `Could not register slash commands (text commands still work): ${error}`)
  }
}
