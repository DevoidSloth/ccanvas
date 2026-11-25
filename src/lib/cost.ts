// What a session's tokens would cost at Claude API list prices. On a Claude
// subscription nothing is billed per token, so this is an API-equivalent
// estimate, not a bill. Prices are US$ per million tokens, from Anthropic's
// published table (checked 2026-11); a model not listed here is left unpriced.

export type ModelTokens = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

type Price = { input: number; output: number; cacheRead?: number }

// first match wins, so a more specific id comes before its family
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/(fable|mythos)-5/, { input: 10, output: 50 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5/, { input: 5, output: 25 }],
  [/opus-4-[5-9]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/sonnet-5/, { input: 2, output: 10 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5 }],
  [/haiku-4-5/, { input: 1, output: 5 }],
  [/haiku-3-5/, { input: 0.8, output: 4 }],
]

function priceOf(model: string): Price | null {
  for (const [re, p] of PRICES) if (re.test(model)) return p
  return null
}

export type SessionCost = {
  /** estimated US$, over the models that have a price */
  usd: number
  /** every token counted, priced or not */
  tokens: number
  /** models with no price (their tokens aren't in `usd`) */
  unpriced: string[]
}

/** Estimated cost of a session's (or several sessions') token use. Cache
 *  writes cost 1.25× input (5-minute) or 2× (1-hour); cache reads 0.1× input
 *  unless the model's price says otherwise. */
export function sessionCost(rows: ModelTokens[] | null | undefined): SessionCost | null {
  if (!rows?.length) return null
  let usd = 0
  let tokens = 0
  const unpriced: string[] = []
  for (const r of rows) {
    tokens += r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h
    const p = priceOf(r.model)
    if (!p) {
      if (!unpriced.includes(r.model)) unpriced.push(r.model)
      continue
    }
    usd +=
      (r.input * p.input +
        r.output * p.output +
        r.cacheRead * (p.cacheRead ?? p.input * 0.1) +
        r.cacheWrite5m * p.input * 1.25 +
        r.cacheWrite1h * p.input * 2) /
      1_000_000
  }
  return { usd, tokens, unpriced }
}

export function fmtUsd(usd: number): string {
  if (usd < 0.01) return usd > 0 ? '<$0.01' : '$0'
  if (usd < 100) return '$' + usd.toFixed(2)
  return '$' + Math.round(usd).toLocaleString()
}

export function fmtTokenCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'K'
  return String(n)
}

/** Several-line tooltip: the total and each model's share. */
export function costTitle(rows: ModelTokens[], c: SessionCost): string {
  const lines = [`≈ ${fmtUsd(c.usd)} at API list prices · ${fmtTokenCount(c.tokens)} tokens`]
  for (const r of rows) {
    const one = sessionCost([r])
    const t = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h
    lines.push(
      `${r.model}: ${fmtTokenCount(t)} tokens` + (one?.unpriced.length ? ' (no price)' : ` · ${fmtUsd(one!.usd)}`),
    )
  }
  lines.push(
    'Subagents that keep their own log aren’t counted. On a subscription this is an API-equivalent estimate, not a bill.',
  )
  return lines.join('\n')
}
