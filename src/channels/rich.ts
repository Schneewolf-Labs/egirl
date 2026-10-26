import type { CardStatus, OutboundChannel, RichCard } from './types'

/**
 * Rendering for structured cards (RichCard, types.ts). One producer builds a card from data it
 * already holds — a finished task, a report, a CI/PR result — and the surface decides how to
 * show it: a Discord embed, or, on a transport without embeds, the markdown fallback here. The
 * fallback is also what a card becomes in a log, a plain chat, or the console.
 */

/** Embed accent colour per status (Discord's blurple for info). */
export const CARD_COLORS: Record<CardStatus, number> = {
  ok: 0x2ecc71,
  warn: 0xf1c40f,
  error: 0xe74c3c,
  info: 0x5865f2,
}

const STATUS_ICON: Record<CardStatus, string> = {
  ok: '✅',
  warn: '⚠️',
  error: '❌',
  info: '•',
}

/** Render a card as markdown, for any surface that cannot show a native card. */
export function renderCardText(card: RichCard): string {
  const lines: string[] = []
  if (card.title) {
    const icon = card.status ? `${STATUS_ICON[card.status]} ` : ''
    lines.push(`**${icon}${card.title}**`)
  }
  if (card.text) lines.push(card.text)
  for (const f of card.fields ?? []) lines.push(`**${f.name}:** ${f.value}`)
  if (card.url) lines.push(card.url)
  if (card.footer) lines.push(`_${card.footer}_`)
  return lines.join('\n').trim()
}

/**
 * Deliver a card the best way the channel allows: a native card when it has one, otherwise the
 * markdown fallback through its plain send(). The one call site every producer uses, so none of
 * them needs to know whether the transport supports embeds.
 */
export async function sendCardOrText(
  channel: OutboundChannel,
  target: string,
  card: RichCard,
): Promise<void> {
  if (channel.sendCard) {
    await channel.sendCard(target, card)
    return
  }
  await channel.send(target, renderCardText(card))
}
