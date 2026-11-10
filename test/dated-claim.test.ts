import { describe, expect, test } from 'bun:test'
import { datedClaimFeedback, findDatedClaim } from '../src/agent/dated-claim'

const NOW = new Date(2026, 10, 8, 12) // 8 November 2026, local time

describe('findDatedClaim', () => {
  test('finds an answer dated to the present', () => {
    for (const [text, phrase] of [
      [
        "Pat Gelsinger is Intel's CEO. As of November 2026, he's still in the role.",
        'As of November 2026',
      ],
      [
        'No, as of November 8, 2026, the iPhone 17 has not been released.',
        'as of November 8, 2026',
      ],
      ['Yes, as of 8 November 2026 he still runs it.', 'as of 8 November 2026'],
      ['Elon Musk is the richest person as of early November 2026.', 'as of early November'],
      ['As of today, the record stands at 2:00:35.', 'As of today'],
      ['It is still supported as of right now.', 'as of right now'],
      ['As of this month the rate is 4.5%.', 'As of this month'],
      ['As of 2026-11-08 the version is 3.14.', 'As of 2026-11-08'],
      ['As of late October, nothing had changed.', 'As of late October'],
      ['As of 2026 he is still the coach.', 'As of 2026'],
    ] as const) {
      expect(findDatedClaim(text, NOW)).toBe(phrase)
    }
  })

  test('leaves stable facts and past dates alone', () => {
    for (const text of [
      'Canberra is currently the capital of Australia.',
      'Mount Everest is still the tallest mountain above sea level.',
      'As of 2015, the CEO of Intel was Brian Krzanich.',
      'As of March 2019 the band had split up.',
      'As of my last update I cannot be sure; I would check a current source.',
      'The law, as of its 2018 revision, places the work under Party leadership.',
    ]) {
      expect(findDatedClaim(text, NOW)).toBeUndefined()
    }
  })

  test('feedback quotes the phrase and asks for a search', () => {
    const fb = datedClaimFeedback('as of November 2026')
    expect(fb).toContain('"as of November 2026"')
    expect(fb).toContain('web_search')
  })
})
