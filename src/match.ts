import type { Database } from "bun:sqlite"
import type { Term } from "./query"
import { isCjk, tokenize, type Token } from "./tokenize"

// A query term compiled twice from the same tokens: into an FTS5 expression (to find candidates) and into a
// matcher over tokens (to highlight). Both use the same rules, so every highlight is a match and every match
// highlights.

export interface Compiled {
  raw: string
  /** Normalized tokens; more than one is a phrase. */
  tokens: string[]
  /** The last token may be a prefix of a longer word. */
  prefix: boolean
  /** Other words one typo away (single-token terms only). */
  variants: string[]
  /** Parts containing the rarest token, as an upper bound on matches. */
  frequency: number
}

/** Prefixes of words more common than this are taken as whole words (typing "the" means the). */
const COMMON = 5000
/** Typos are looked for only when the word itself is this rare. */
const RARE = 50

export type MatchKind = "exact" | "prefix" | "typo"

export function compile(db: Database, term: Term, options: { fuzzy: boolean }): Compiled | undefined {
  const tokens = tokenize(term.raw)
    .filter((token) => !token.part)
    .map((token) => token.text)
  if (!tokens.length) return undefined
  const last = tokens.at(-1)!
  const frequency = Math.min(...tokens.map((token) => documents(db, token)))
  const fuzzy = options.fuzzy && !term.quoted && !isCjk(last)
  const lastFrequency = tokens.length === 1 ? frequency : documents(db, last)
  const prefix = fuzzy && last.length >= 3 && lastFrequency < COMMON
  const variants =
    fuzzy && tokens.length === 1 && last.length >= 4 && frequency < RARE && /^\p{L}+$/u.test(last) ? typos(db, last) : []
  return { raw: term.raw, tokens, prefix, variants, frequency }
}

/** Number of parts containing a token (fts5vocab reads it from the index). */
export function documents(db: Database, token: string) {
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, fts, 'row')")
  return db.query<{ doc: number }, [string]>("SELECT doc FROM temp.fts_vocab WHERE term = ?").get(token)?.doc ?? 0
}

/** FTS5 expression for one term. `exact` leaves out prefixes and typos. */
export function ftsExpression(term: Compiled, exact = false) {
  const phrase = quote(term.tokens.join(" "))
  if (exact) return phrase
  const options = [phrase, ...(term.prefix ? [`${phrase} *`] : []), ...term.variants.map(quote)]
  return options.length === 1 ? phrase : `(${options.join(" OR ")})`
}

function quote(text: string) {
  return `"${text.replaceAll('"', '""')}"`
}

/** Words in the index one typo away (edit or swap), sharing the first or second letter; the most common first. */
function typos(db: Database, word: string): string[] {
  const max = 1
  const heads = [...new Set([word[0]!, word[1]!])]
  const rows = db
    .query<{ term: string }, [string, number, number]>("SELECT term FROM vocab WHERE head = ? AND len BETWEEN ? AND ?")
  const found: { term: string; count: number }[] = []
  for (const head of heads) {
    for (const row of rows.all(head, word.length - max, word.length + max)) {
      if (row.term === word) continue
      if (damerau(word, row.term, max) <= max) found.push({ term: row.term, count: documents(db, row.term) })
    }
  }
  return found
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((item) => item.term)
}

/** Optimal string alignment distance, giving up (returning max + 1) once it exceeds max. */
export function damerau(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prev2[j - 2]! + 1)
      row.push(value)
      best = Math.min(best, value)
    }
    if (best > max) return max + 1
    prev2 = prev
    prev = row
  }
  return prev[b.length]!
}

export interface Range {
  start: number
  end: number
  /** Index of the query term. */
  term: number
  kind: MatchKind
}

/** Where the terms match in `text`, in order, without overlaps. */
export function highlight(text: string, terms: Compiled[]): Range[] {
  if (text.length <= LONG) return highlightTokens(text, tokenize(text), terms)
  // Long text: tokenize only around places a plain regex finds (case-insensitive, so a superset of matches except
  // for accents, which fall back to the whole text). At most the first MAX_SPOTS.
  const spots = [...text.matchAll(spotPattern(terms))].slice(0, MAX_SPOTS)
  if (!spots.length) return highlightTokens(text, tokenize(text), terms)
  const windows: [number, number][] = []
  for (const spot of spots) {
    const start = wordStart(text, Math.max(0, spot.index - 64))
    const end = wordEnd(text, Math.min(text.length, spot.index + spot[0].length + 64))
    const last = windows.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else windows.push([start, end])
  }
  const tokens = windows.flatMap(([start, end]) =>
    tokenize(text.slice(start, end)).map((token) => ({ ...token, start: token.start + start, end: token.end + start })),
  )
  return highlightTokens(text, tokens, terms)
}

const LONG = 4000
const MAX_SPOTS = 200

function spotPattern(terms: Compiled[]) {
  // Tokens are letters and digits only, nothing to escape.
  return new RegExp(terms.flatMap((term) => [term.tokens[0]!, ...term.variants]).join("|"), "giu")
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

function wordStart(text: string, index: number) {
  while (index > 0 && WORD_CHAR.test(text[index - 1]!)) index--
  return index
}

function wordEnd(text: string, index: number) {
  while (index < text.length && WORD_CHAR.test(text[index]!)) index++
  return index
}

function highlightTokens(text: string, tokens: Token[], terms: Compiled[]): Range[] {
  const whole = tokens.filter((token) => !token.part)
  const ranges: Range[] = []
  terms.forEach((term, index) => {
    if (term.tokens.length === 1) {
      const variants = new Set(term.variants)
      const target = term.tokens[0]!
      for (const token of tokens) {
        const kind = matchToken(token.text, target, term.prefix, variants)
        if (kind) ranges.push({ start: token.start, end: kind === "prefix" ? token.start + prefixLength(text, token, target) : token.end, term: index, kind })
      }
      return
    }
    // Phrase: consecutive whole tokens (or consecutive parts of one identifier).
    for (const sequence of [whole, tokens.filter((token) => token.part)]) {
      for (let i = 0; i + term.tokens.length <= sequence.length; i++) {
        const lastIndex = term.tokens.length - 1
        const ok = term.tokens.every((want, k) => {
          const got = sequence[i + k]!.text
          return k === lastIndex && term.prefix ? got.startsWith(want) : got === want
        })
        if (!ok) continue
        const lastToken = sequence[i + lastIndex]!
        const exactLast = lastToken.text === term.tokens[lastIndex]
        ranges.push({
          start: sequence[i]!.start,
          end: exactLast ? lastToken.end : lastToken.start + prefixLength(text, lastToken, term.tokens[lastIndex]!),
          term: index,
          kind: exactLast ? "exact" : "prefix",
        })
      }
    }
  })
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  let covered = -1
  return ranges.filter((range) => {
    if (range.start < covered) return false
    covered = range.end
    return true
  })
}

function matchToken(token: string, target: string, prefix: boolean, variants: Set<string>): MatchKind | undefined {
  if (token === target) return "exact"
  if (variants.has(token)) return "typo"
  if (prefix && token.startsWith(target)) return "prefix"
  return undefined
}

// Original-text length of the first `prefix.length` normalized characters of a token (they differ only when
// normalization changed the length, e.g. a decomposed accent).
function prefixLength(text: string, token: { start: number; end: number }, prefix: string) {
  const original = text.slice(token.start, token.end)
  if (original.length === token.end - token.start && original.toLowerCase().startsWith(prefix)) return prefix.length
  for (let n = 1; n <= original.length; n++) {
    if (original.slice(0, n).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().length >= prefix.length) return n
  }
  return original.length
}
