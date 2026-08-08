#!/usr/bin/env bun
/**
 * Paired comparison of two bench runs.
 *
 * Comparing two pass-rates as independent numbers throws away most of the signal. Across a recent
 * model lineage the totals went 47/47 → 46/47 → 45/47 — monotone, and completely unresolvable by
 * looking at the rates, because with this many binary cases a one-case difference sits well
 * inside the standard error.
 *
 * The runs answered the *same* cases, and the overwhelming majority are answered identically.
 * Only the disagreements carry information. McNemar's exact test uses exactly those: b = cases
 * the baseline passed and the variant failed, c = the reverse. Under the null that nothing
 * changed, each discordant case is a coin flip, so the evidence lives in b vs c rather than in n.
 *
 * It also prints which cases flipped, in both directions. That matters more than the p-value in
 * practice: three losses all on abstention cases is a restraint regression worth acting on even
 * at p = 0.25, while three scattered across unrelated axes is churn.
 *
 * Usage: bun bench/compare.ts --base wichtel --variant wichtel-verstand
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..')

interface Outcome {
  id: string
  axis: string
  pass: boolean
  detail: string
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function load(label: string): Map<string, Outcome> {
  const p = join(ROOT, 'bench', 'results', `${label}.json`)
  const data = JSON.parse(readFileSync(p, 'utf8'))
  return new Map((data.results as Outcome[]).map((r) => [r.id, r]))
}

/** log(n choose k), via lgamma, to keep large-n binomials from overflowing. */
function lgamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (const ci of c) ser += ci / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

/** Exact two-sided binomial test on the discordant pairs. */
function mcnemar(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  let tail = 0
  for (let i = 0; i <= k; i++) {
    const logC = lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1)
    tail += Math.exp(logC + n * Math.log(0.5))
  }
  return Math.min(1, 2 * tail)
}

function main() {
  const baseLabel = arg('base')
  const variantLabel = arg('variant')
  if (!baseLabel || !variantLabel) {
    console.error('usage: bun bench/compare.ts --base <label> --variant <label>')
    process.exit(2)
  }

  const base = load(baseLabel)
  const variant = load(variantLabel)
  const ids = [...base.keys()].filter((id) => variant.has(id))

  const lost = ids.filter((id) => base.get(id)!.pass && !variant.get(id)!.pass)
  const won = ids.filter((id) => !base.get(id)!.pass && variant.get(id)!.pass)
  const p = mcnemar(lost.length, won.length)

  const basePass = ids.filter((id) => base.get(id)!.pass).length
  const varPass = ids.filter((id) => variant.get(id)!.pass).length

  console.log(`shared cases: ${ids.length}`)
  console.log(`  ${baseLabel.padEnd(24)} ${basePass}/${ids.length}`)
  console.log(`  ${variantLabel.padEnd(24)} ${varPass}/${ids.length}`)
  console.log(`\n  lost ${lost.length}, won ${won.length}, p = ${p.toFixed(3)}`)

  const verdict =
    lost.length === 0 && won.length === 0
      ? 'identical'
      : p < 0.05
        ? lost.length > won.length
          ? 'REGRESSION'
          : 'improvement'
        : 'no measurable change'
  console.log(`  ${verdict}\n`)

  // Direction by axis: where the flips land is usually more actionable than the p-value.
  const byAxis = new Map<string, { lost: number; won: number }>()
  for (const id of lost) {
    const a = byAxis.get(base.get(id)!.axis) ?? { lost: 0, won: 0 }
    a.lost++
    byAxis.set(base.get(id)!.axis, a)
  }
  for (const id of won) {
    const a = byAxis.get(base.get(id)!.axis) ?? { lost: 0, won: 0 }
    a.won++
    byAxis.set(base.get(id)!.axis, a)
  }
  if (byAxis.size) {
    console.log('  flips by axis:')
    for (const [axis, a] of [...byAxis].sort()) {
      console.log(`    ${axis.padEnd(12)} -${a.lost} +${a.won}`)
    }
  }
  if (lost.length) {
    console.log('\n  lost:')
    for (const id of lost) console.log(`    ${id.padEnd(26)} ${variant.get(id)!.detail}`)
  }
  if (won.length) {
    console.log('\n  won:')
    for (const id of won) console.log(`    ${id.padEnd(26)} ${base.get(id)!.detail}`)
  }
}

main()
