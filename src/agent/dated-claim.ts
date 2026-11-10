/**
 * Dated-claim guard for stateless answers. With thinking off, a local model asked "is X still Y?" sometimes
 * skips the search it was trained to make and answers from memory, then stamps the answer with the date it
 * finds in its context: "As of November 2026, he's still in the role." The date makes a stale answer read
 * as checked. When the run made no tool call, an answer that dates itself to the present is a claim about
 * now that nothing verified, so the loop gets one validation retry telling it to search first.
 *
 * Narrow on purpose: it matches "as of" + a present-day anchor (today, now, this month, the current month
 * or year), not "currently" or "still", which a correct answer about a stable fact uses all the time.
 */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/** The "as of <present>" phrases that date an answer to the moment it was written. */
function presentAnchors(now: Date): RegExp {
  const year = now.getFullYear()
  const month = MONTHS[now.getMonth()]
  const prev = MONTHS[(now.getMonth() + 11) % 12]
  const anchors = [
    'today',
    'now',
    'right now',
    'this (?:week|month|year)',
    'the (?:present|moment|time of writing)',
    `(?:early|mid|late)[- ](?:${month}|${prev})`,
    `(?:${month}|${prev})(?: \\d{1,2})?(?:,? ${year})?`,
    `\\d{1,2} (?:${month}|${prev})(?:,? ${year})?`,
    `${year}-\\d{2}(?:-\\d{2})?`,
    `${year}`,
  ]
  return new RegExp(`\\bas of (?:${anchors.join('|')})\\b`, 'i')
}

/** The phrase in `content` that dates it to the present, or undefined. */
export function findDatedClaim(content: string, now: Date = new Date()): string | undefined {
  return content.match(presentAnchors(now))?.[0]
}

/** Feedback for the one validation retry. */
export function datedClaimFeedback(phrase: string): string {
  return `Your answer says "${phrase}", but you did not check anything in this run: that date only tells the reader the answer is current, and an answer from memory can be out of date. Search for it now with web_search and answer from the results. If the search doesn't settle it, say what you found and that you couldn't confirm it.`
}
