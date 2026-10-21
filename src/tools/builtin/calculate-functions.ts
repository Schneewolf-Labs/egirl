/** The names the calculate tool resolves: constants and functions, nothing else. */

export const CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['e', Math.E],
])

export type Fn = { arity: [number, number]; apply: (args: number[]) => number }

const unary = (f: (x: number) => number): Fn => ({ arity: [1, 1], apply: (a) => f(a[0] as number) })

export const FUNCTIONS = new Map<string, Fn>([
  ['sqrt', unary(Math.sqrt)],
  ['abs', unary(Math.abs)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['log', unary(Math.log)],
  ['ln', unary(Math.log)],
  ['log10', unary(Math.log10)],
  ['log2', unary(Math.log2)],
  ['exp', unary(Math.exp)],
  ['sin', unary(Math.sin)],
  ['cos', unary(Math.cos)],
  ['tan', unary(Math.tan)],
  [
    'round',
    {
      arity: [1, 2],
      // Half away from zero (-2.5 -> -3), the way people and money round; Math.round goes up
      apply: ([x, digits = 0]) => {
        const f = 10 ** Math.trunc(digits as number)
        return (Math.sign(x as number) * Math.round(Math.abs(x as number) * f)) / f
      },
    },
  ],
  ['min', { arity: [1, Number.POSITIVE_INFINITY], apply: (a) => Math.min(...a) }],
  ['max', { arity: [1, Number.POSITIVE_INFINITY], apply: (a) => Math.max(...a) }],
])
