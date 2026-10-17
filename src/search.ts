import type { Kind } from "./model"
import { compile, ftsExpression, highlight, type Compiled, type Range } from "./match"
import { matchesDate, matchesFilter, parseQuery, type Query } from "./query"
import { CODE_KIND, KIND_CODE, kindOf, rowidRange, unpackText, type Store } from "./store"

export interface SessionSummary {
  harness: string
  id: string
  title: string
  directory: string
  created: number
  updated: number
  parent?: string
  archived?: number
  model?: string
  messages: number
}

export interface Hit {
  kind: Kind | "title"
  /** Message id ("" for the title). */
  message: string
  /** Position of the message in the session, from 0. */
  seq: number
  time: number
  tool?: string
  /** Excerpt around the matches; `before`/`after` say whether text was cut there. */
  text: string
  before: boolean
  after: boolean
  /** Highlights within `text`. */
  ranges: Range[]
  /** Length of the whole part. */
  length: number
}

export interface Result {
  session: SessionSummary
  score: number
  /** Parts that match every term. */
  matches: number
  /** The terms only match spread over several parts. */
  spread: boolean
  hits: Hit[]
  /** Other sessions with the same best match (forks of this one, or its origin). */
  copies?: SessionSummary[]
}

export interface SearchOptions {
  limit?: number
  offset?: number
  /** Hits per session. */
  hits?: number
  /** Characters of context in each hit. */
  context?: number
  fuzzy?: boolean
  now?: number
}

export interface SearchResult {
  query: Query
  terms: Compiled[]
  results: Result[]
  /** Sessions matching in total (before limit/offset). */
  total: number
  ms: number
}

const DAY = 86400e3

interface Candidate {
  session: number
  matches: number
  /** bm25 of the best part (lower is better). */
  best: number
  title: boolean
  exact: boolean
  spread: boolean
  /** Parts to show, best first. */
  picks: number[]
}

interface SessionRow {
  num: number
  harness: string
  id: string
  title: string
  directory: string
  created: number
  updated: number
  parent: string | null
  archived: number | null
  model: string | null
  messages: number
}

export function search(store: Store, input: string, options: SearchOptions = {}): SearchResult {
  const started = performance.now()
  const now = options.now ?? Date.now()
  const query = parseQuery(input, now)
  const db = store.db
  const fuzzy = options.fuzzy ?? true
  const terms = query.terms.flatMap((term) => compile(db, term, { fuzzy }) ?? [])
  const excluded = query.excluded.flatMap((term) => compile(db, term, { fuzzy: false }) ?? [])
  const sessions = allowedSessions(store, query, now)
  const kinds = query.kinds ? [...query.kinds].map((kind) => KIND_CODE[kind]) : undefined
  const limit = options.limit ?? 20
  const offset = options.offset ?? 0

  if (!terms.length) {
    const skip = excludedSessions(store, excluded, kinds)
    const rows = [...sessions.values()].filter((row) => !skip.has(row.num))
    rows.sort((a, b) => rank(b, 1, now) - rank(a, 1, now))
    return {
      query,
      terms,
      results: rows.slice(offset, offset + limit).map((row) => ({ session: summary(row), score: rank(row, 1, now), matches: 0, spread: false, hits: [] })),
      total: rows.length,
      ms: performance.now() - started,
    }
  }

  const scope = sessionScope(sessions, query)
  const candidates = new Map<number, Candidate>()
  for (const exact of [true, false]) {
    if (!exact && !terms.some((term) => term.prefix || term.variants.length)) continue
    for (const row of grouped(store, terms.map((term) => ftsExpression(term, exact)).join(" AND "), kinds, scope)) {
      if (!sessions.has(row.s) || candidates.has(row.s)) continue
      candidates.set(row.s, { session: row.s, matches: row.n, best: row.best, title: row.title, exact, spread: false, picks: row.picks })
    }
  }
  // Terms spread over different parts of one session still find it, ranked lower.
  if (terms.length > 1) {
    const perTerm = terms.map((term) => sessionSet(store, ftsExpression(term), kinds, scope))
    const [first, ...others] = perTerm
    for (const session of first!) {
      if (candidates.has(session) || !sessions.has(session) || !others.every((set) => set.has(session))) continue
      candidates.set(session, { session, matches: 0, best: 0, title: false, exact: false, spread: true, picks: [] })
    }
  }
  const skip = excludedSessions(store, excluded, kinds)
  const ranked = [...candidates.values()]
    .filter((candidate) => !skip.has(candidate.session))
    .map((candidate) => ({ candidate, row: sessions.get(candidate.session)!, score: 0 }))
  for (const item of ranked) item.score = rank(item.row, relevance(item.candidate), now)
  ranked.sort((a, b) => tier(b.candidate) - tier(a.candidate) || b.score - a.score || b.row.updated - a.row.updated)

  // Forks copy their origin's history, so one match can appear in several sessions. A result is folded into a
  // better-ranked one when its first hit is the same text at the same position and both sessions begin alike.
  const want = options.hits ?? 3
  const context = options.context ?? 120
  const results: Result[] = []
  const seen = new Map<string, Result>()
  let skipped = 0
  for (let start = 0; start < ranked.length && results.length < limit; ) {
    const batch = ranked.slice(start, start + offset + limit - skipped - results.length + 4)
    start += batch.length
    const found = pickHits(store, batch.map((item) => ({ num: item.row.num, candidate: item.candidate })), terms, kinds, Math.max(1, want), context)
    for (const item of batch) {
      if (results.length >= limit) break
      const picked = found.get(item.row.num) ?? []
      const key = picked[0]?.key
      const original = key === undefined ? undefined : seen.get(key)
      if (original) {
        original.copies = [...(original.copies ?? []), summary(item.row)]
        continue
      }
      const result: Result = {
        session: summary(item.row),
        score: item.score,
        matches: item.candidate.matches,
        spread: item.candidate.spread,
        hits: picked
          .slice(0, want)
          .map(({ key, ...hit }) => hit)
          .sort((a, b) => a.seq - b.seq),
      }
      if (key !== undefined) seen.set(key, result)
      if (skipped < offset) skipped++
      else results.push(result)
    }
  }
  return { query, terms, results, total: ranked.length, ms: performance.now() - started }
}

/**
 * Strict tiers, whatever the age: every word exactly in one part, then in one part counting prefixes and typos, then
 * spread over several parts.
 */
function tier(candidate: Candidate) {
  if (candidate.spread) return 0
  return candidate.exact ? 2 : 1
}

/** Within a tier: the best part's bm25 and how many parts match. */
function relevance(candidate: Candidate) {
  if (candidate.spread) return 1
  return (Math.max(-candidate.best, 0.5) + 0.5 * Math.log2(1 + candidate.matches)) * (candidate.title ? 1.5 : 1)
}

/** Recent sessions first among similar matches: x2.5 today, x1.75 two weeks ago, toward x1 (fast-resume's curve). */
function rank(row: SessionRow, relevance: number, now: number) {
  const age = Math.max(0, now - row.updated)
  const recency = 1 + 1.5 * 2 ** (-age / (14 * DAY))
  return relevance * recency * (row.archived ? 0.5 : 1)
}

function allowedSessions(store: Store, query: Query, now: number) {
  const rows = store.db
    .query<SessionRow, []>(
      "SELECT num, harness, id, title, directory, created, updated, parent, archived, model, messages FROM session",
    )
    .all()
  const allowed = rows.filter(
    (row) =>
      matchesFilter(query.agent, row.harness, false) &&
      matchesFilter(query.dir, row.directory, true) &&
      matchesDate(query.date, row.updated || now) &&
      (query.archived === undefined || Boolean(row.archived) === query.archived) &&
      (query.child === undefined || Boolean(row.parent) === query.child) &&
      (query.session === undefined || row.id.startsWith(query.session)),
  )
  return new Map(allowed.map((row) => [row.num, row]))
}

/** With `session:` the search reads only that session's rows. */
function sessionScope(sessions: Map<number, SessionRow>, query: Query) {
  if (query.session === undefined || sessions.size !== 1) return undefined
  return rowidRange([...sessions.keys()][0]!)
}

function where(kinds: number[] | undefined, scope: readonly [number, number] | undefined) {
  return [
    kinds ? ` AND rowid % 8 IN (${kinds.join(",")})` : "",
    scope ? ` AND rowid BETWEEN ${scope[0]} AND ${scope[1]}` : "",
  ].join("")
}

// Above this many matching parts, bm25 (most of the cost) is skipped and parts are only counted.
const HEAVY = 20000

/**
 * Matching sessions with their number of matching parts and best bm25 (when there are few enough matches to afford
 * it), plus candidate parts to show: the newest prompt, reply or title, the best by bm25, the newest reasoning, the newest
 * and the oldest. One pass collects them, so showing hits never re-runs the match.
 */
function grouped(store: Store, expression: string, kinds: number[] | undefined, scope: readonly [number, number] | undefined) {
  // Each aggregate costs per matching row, so only a few.
  const columns = [
    "max(CASE WHEN rowid % 8 IN (0, 1, 6) THEN rowid END) AS said",
    "max(CASE WHEN rowid % 8 = 2 THEN rowid END) AS thought",
    "max(rowid) AS newest",
    "min(rowid) AS oldest",
    "max(rowid % 8 = 6) AS title",
  ]
  const counted = store.db
    .query<Record<string, number | null> & { s: number; n: number }, [string]>(
      `SELECT rowid / 268435456 AS s, count(*) AS n, ${columns.join(", ")} FROM fts WHERE fts MATCH ?${where(kinds, scope)} GROUP BY s`,
    )
    .all(expression)
  const scored =
    counted.reduce((sum, row) => sum + row.n, 0) > HEAVY
      ? new Map<number, { best: number; top: number }>()
      : new Map(
          store.db
            .query<{ s: number; best: number; top: number }, [string]>(
              `WITH m AS MATERIALIZED (SELECT rowid AS id, rowid / 268435456 AS s, bm25(fts) AS b FROM fts WHERE fts MATCH ?${where(kinds, scope)})
               SELECT s, min(b) AS best, id AS top FROM m GROUP BY s`,
            )
            .all(expression)
            .map((row) => [row.s, row]),
        )
  return counted.map((row) => {
    const top = scored.get(row.s)?.top
    const picks = [row.said, top, row.thought, row.newest, row.oldest].filter((rowid): rowid is number => typeof rowid === "number")
    return {
      s: row.s,
      n: row.n,
      best: scored.get(row.s)?.best ?? 0,
      title: row.title === 1,
      picks: [...new Set(picks)],
    }
  })
}

function sessionSet(store: Store, expression: string, kinds: number[] | undefined, scope: readonly [number, number] | undefined) {
  return new Set(
    store.db
      .query<{ s: number }, [string]>(`SELECT DISTINCT rowid / 268435456 AS s FROM fts WHERE fts MATCH ?${where(kinds, scope)}`)
      .all(expression)
      .map((row) => row.s),
  )
}

function excludedSessions(store: Store, excluded: Compiled[], kinds: number[] | undefined) {
  if (!excluded.length) return new Set<number>()
  return sessionSet(store, excluded.map((term) => ftsExpression(term, true)).join(" OR "), kinds, undefined)
}

/** The best parts of one session: those matching every term first, then any term. */
/**
 * The parts to show for a page of results: those the match collected (see grouped), or for sessions where the terms
 * only match in different parts, the newest parts with any of them.
 */
function pickHits(
  store: Store,
  sessions: { num: number; candidate: Candidate }[],
  terms: Compiled[],
  kinds: number[] | undefined,
  count: number,
  context: number,
) {
  const exactTerms = terms.map((term) => ({ ...term, prefix: false, variants: [] }))
  const picked = new Map(sessions.map((item) => [item.num, item.candidate.picks.slice(0, count)]))
  // Sessions where the terms only match in different parts: the newest parts with any of them.
  const anyTerm = terms.map((term) => ftsExpression(term)).join(" OR ")
  for (const item of sessions.filter((item) => item.candidate.spread)) {
    const [low, high] = rowidRange(item.num)
    const rows = store.db
      .query<{ rowid: number }, [string]>(
        `SELECT rowid FROM fts WHERE fts MATCH ?${where(kinds, [low, high])} ORDER BY rowid DESC LIMIT 100`,
      )
      .all(anyTerm)
    picked.set(
      item.num,
      rows
        .map((row) => row.rowid)
        .sort((x, y) => PRIORITY[kindOf(x)]! - PRIORITY[kindOf(y)]! || y - x)
        .slice(0, count),
    )
  }
  const entry = store.db.query<
    { message: string; tool: string | null; text: string | Uint8Array; seq: number | null; time: number | null },
    [number, number]
  >(
    `SELECT e.message, e.tool, e.text, m.seq, m.time FROM entry e
     LEFT JOIN message m ON m.session = ? AND m.id = e.message WHERE e.rowid = ?`,
  )
  const exactSessions = new Set(sessions.filter((item) => item.candidate.exact).map((item) => item.num))
  return new Map(
    [...picked].map(([num, rowids]) => [
      num,
      rowids.flatMap((rowid) => {
        const found = entry.get(num, rowid)
        if (!found) return []
        const row = { ...found, text: unpackText(found.text) }
        const ranges = highlight(row.text, exactSessions.has(num) ? exactTerms : terms)
        return [
          {
            ...excerpt(row.text, ranges, context),
            key: `${row.seq}:${kindOf(rowid)}:${Bun.hash(row.text)}:${firstPart(store, num)}`,
            kind: CODE_KIND[kindOf(rowid)]!,
            message: row.message,
            seq: row.seq ?? -1,
            time: row.time ?? 0,
            tool: row.tool ?? undefined,
            length: row.text.length,
          },
        ]
      }),
    ]),
  )
}

function firstPart(store: Store, session: number) {
  const [low, high] = rowidRange(session)
  const row = store.db
    .query<{ text: string | Uint8Array }, [number, number]>("SELECT text FROM entry WHERE rowid BETWEEN ? AND ? AND rowid % 8 != 6 ORDER BY rowid LIMIT 1")
    .get(low, high)
  return row ? Bun.hash(unpackText(row.text)) : 0
}

// By kind code: title, user, assistant, then reasoning, tool calls, system, tool results.
const PRIORITY = [1, 1, 2, 3, 5, 4, 0, 9]

/** A window of about 2 x context characters around the densest cluster of matches, cut at whitespace. */
function excerpt(text: string, ranges: Range[], context: number) {
  if (text.length <= context * 2 || !ranges.length) {
    const end = Math.min(text.length, context * 2)
    return { text: text.slice(0, end), before: false, after: end < text.length, ranges: ranges.filter((range) => range.end <= end) }
  }
  // The window covering the most distinct terms, then the most matches.
  let best = { start: ranges[0]!.start, score: -1 }
  for (const anchor of ranges) {
    const inside = ranges.filter((range) => range.start >= anchor.start && range.end <= anchor.start + context * 1.5)
    const score = new Set(inside.map((range) => range.term)).size * 1000 + inside.length
    if (score > best.score) best = { start: anchor.start, score }
  }
  let start = Math.max(0, best.start - Math.floor(context / 2))
  let end = Math.min(text.length, start + context * 2)
  start = Math.max(0, end - context * 2)
  if (start > 0) {
    const space = text.slice(start, start + 20).search(/\s/)
    if (space >= 0) start += space + 1
  }
  if (end < text.length) {
    const space = text.slice(Math.max(start, end - 20), end).search(/\s\S*$/)
    if (space >= 0) end = Math.max(start, end - 20) + space
  }
  return {
    text: text.slice(start, end),
    before: start > 0,
    after: end < text.length,
    ranges: ranges.filter((range) => range.start >= start && range.end <= end).map((range) => ({ ...range, start: range.start - start, end: range.end - start })),
  }
}

function summary(row: SessionRow): SessionSummary {
  return {
    harness: row.harness,
    id: row.id,
    title: row.title,
    directory: row.directory,
    created: row.created,
    updated: row.updated,
    parent: row.parent ?? undefined,
    archived: row.archived ?? undefined,
    model: row.model ?? undefined,
    messages: row.messages,
  }
}
