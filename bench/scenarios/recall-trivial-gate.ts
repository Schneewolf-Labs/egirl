/**
 * recall-trivial-gate: greetings must not drag stored memories into the turn; a real question
 * about those memories must.
 *
 * Production symptom: an instance with a store full of heartbeat bookkeeping answered "hey
 * juno" with four recalled heartbeat entries injected above it. retrieveForContext gates on
 * an anchored TRIVIAL_RE, which "hey juno" and "yo yo" missed.
 *
 * All turns run in one session, in order, because that is how the junk shows up live: a
 * greeting into an ongoing conversation. Each check looks only at the messages its own turn
 * added (see turnTail), so recall left in history by the control turn cannot be blamed on
 * "thanks!" after it. The control turn proves the check can fail and that recall works at all.
 */

import { findRecall, oneLine, operatorRequest, turnTail, wasEmbedded } from './checks'
import { type CheckResult, fail, type InstanceScenario, pass, type TurnResult } from './types'

const CONTROL = 'what does the heartbeat check monitor?'

// Shaped like what auto-extraction and heartbeat runs actually leave behind.
const SEEDS: Array<{ key: string; value: string; source?: 'auto' | 'conversation' }> = [
  {
    key: 'auto/task/heartbeat/heartbeat_git_monitoring',
    value:
      'One heartbeat check monitors git activity: if idle 4+ hours, generate a summary of recent commits and post it to the principal.',
  },
  {
    key: 'auto/task/heartbeat/heartbeat_disk_check',
    value:
      'Heartbeat checks disk usage on the workspace volume every run and reports when free space drops below 10%.',
  },
  {
    key: 'auto/task/heartbeat/heartbeat_last_run',
    value:
      'Last heartbeat run completed with no findings; next scheduled check in 30 minutes. Summary: nothing to report.',
  },
  {
    // The daily-log indexer's key shape (log:<date>:<chunk>).
    key: 'log:2026-11-25:0',
    source: 'conversation',
    value:
      'SET auto/task/heartbeat/heartbeat_git_monitoring [general]: One heartbeat check monitors git activity... heartbeat run finished, left off summarizing unfinished work.',
  },
]

function noRecall(turn: TurnResult | undefined, name: string): CheckResult {
  if (!turn) return fail(name, 'turn never ran')
  if (turn.error) return fail(name, `turn failed: ${turn.error}`)
  const req = operatorRequest(turn)
  if (!req) return fail(name, 'no operator request carrying this turn was recorded')
  const embedded = wasEmbedded(turn)
    ? 'query was embedded (gate let it through)'
    : 'query not embedded'
  const hit = findRecall(turnTail(req, turn.text))
  return hit
    ? fail(name, `request #${req.seq} injected: ${hit} [${embedded}]`)
    : pass(name, `request #${req.seq}: no recall block [${embedded}]`)
}

function hasRecall(turn: TurnResult | undefined, name: string): CheckResult {
  if (!turn) return fail(name, 'turn never ran')
  if (turn.error) return fail(name, `turn failed: ${turn.error}`)
  const req = operatorRequest(turn)
  if (!req) return fail(name, 'no operator request carrying this turn was recorded')
  const hit = findRecall(turnTail(req, turn.text))
  return hit
    ? pass(name, `request #${req.seq} injected: ${oneLine(hit, 160)}`)
    : fail(name, `request #${req.seq}: expected a recall block, found none`)
}

export const recallTrivialGate: InstanceScenario = {
  name: 'recall-trivial-gate',
  description: 'greetings get no recalled memories; a real question does',

  config: ({ embeddings }) => ({
    memory: { proactive_retrieval: true, auto_extract: false },
    local: {
      embeddings: {
        provider: 'llamacpp',
        endpoint: embeddings.endpoint,
        model: 'scenario-embed',
        dimensions: embeddings.dims,
        multimodal: false,
      },
    },
  }),

  async setup({ memory }) {
    const m = memory()
    for (const s of SEEDS) {
      await m.set(s.key, s.value, { source: s.source ?? 'auto' })
    }
  },

  // /continue is not checked here: the HTTP API doesn't run slash commands (it sends
  // "/continue" to the model verbatim), and the continuation text typed by a user is meant to
  // recall. The harness-written /continue turn is covered in-process by
  // test/memory/retrieval.test.ts and test/agent/recall.test.ts (isHarnessTurn).
  turns: [{ text: 'hey juno' }, { text: 'yo yo' }, { text: CONTROL }, { text: 'thanks!' }],

  checks: ({ turns }) => {
    const byText = (t: string) => turns.find((r) => r.text === t)
    return [
      noRecall(byText('hey juno'), 'no-recall: "hey juno"'),
      noRecall(byText('yo yo'), 'no-recall: "yo yo"'),
      noRecall(byText('thanks!'), 'no-recall: "thanks!"'),
      hasRecall(byText(CONTROL), 'control-recall: heartbeat question'),
    ]
  },
}
