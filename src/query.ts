import type { Kind } from "./model"

// Query syntax (fast-resume's filters, plus a few for transcripts):
//
//   free words          all must appear (typos and prefixes allowed for longer words)
//   "exact phrase"      these words in this order, no typo matching
//   -word               sessions mentioning it are left out
//   agent:claude,codex  harness (also -agent:pi, agent:!pi)
//   dir:backend         directory contains (case-insensitive)
//   date:<2d  date:>1w  date:today  date:yesterday  date:week  date:month   (units m h d w mo y)
//   in:user,reasoning   only these parts: user assistant reasoning tool (= call + result) call result system title
//   is:archived is:child  (and -is:archived, -is:child); archived sessions rank lower but are included by default
//   session:ID          one session (prefix of the id)

export interface Filter {
  include: string[]
  exclude: string[]
}

export interface DateFilter {
  /** Epoch ms; sessions updated at or after (op "<": newer than) or before (op ">": older than). */
  cutoff: number
  /** For today / yesterday: end of the day. */
  until?: number
  op: "<" | ">" | "="
  negated: boolean
}

export interface Term {
  /** As typed, for display. */
  raw: string
  /** Quoted: a phrase, matched exactly. */
  quoted: boolean
}

export interface Query {
  terms: Term[]
  excluded: Term[]
  agent?: Filter
  dir?: Filter
  date?: DateFilter
  kinds?: Set<Kind | "title">
  archived?: boolean
  child?: boolean
  session?: string
}

const KEYWORD = /(^|\s)(-?)(agent|harness|dir|date|in|is|session):(?:"([^"]*)"|(\S*))/g
const TERM = /(-?)(?:"([^"]*)"?|(\S+))/g

const KIND_ALIASES: Record<string, (Kind | "title")[]> = {
  user: ["user"],
  assistant: ["assistant"],
  text: ["user", "assistant"],
  reasoning: ["reasoning"],
  thinking: ["reasoning"],
  tool: ["tool-call", "tool-result"],
  tools: ["tool-call", "tool-result"],
  call: ["tool-call"],
  input: ["tool-call"],
  result: ["tool-result"],
  output: ["tool-result"],
  system: ["system"],
  title: ["title"],
}

export function parseQuery(input: string, now = Date.now()): Query {
  const query: Query = { terms: [], excluded: [] }
  const rest = input.replace(KEYWORD, (_, lead: string, minus: string, key: string, quoted?: string, plain?: string) => {
    const value = quoted ?? plain ?? ""
    const negated = minus === "-"
    if (key === "agent" || key === "harness") query.agent = filter(value.toLowerCase(), negated)
    if (key === "dir") query.dir = filter(value, negated)
    if (key === "date") query.date = parseDate(value, negated, now)
    if (key === "session" && value) query.session = value
    if (key === "in") {
      const kinds = filter(value.toLowerCase(), negated)
      const include = kinds.include.flatMap((name) => KIND_ALIASES[name] ?? [])
      const exclude = new Set(kinds.exclude.flatMap((name) => KIND_ALIASES[name] ?? []))
      const base = include.length ? include : Object.values(KIND_ALIASES).flat()
      query.kinds = new Set(base.filter((kind) => !exclude.has(kind)))
    }
    if (key === "is") {
      for (const name of value.toLowerCase().split(",")) {
        const not = negated || name.startsWith("!")
        const bare = name.replace(/^!/, "")
        if (bare === "archived") query.archived = !not
        if (bare === "child" || bare === "subagent" || bare === "worker") query.child = !not
      }
    }
    return lead
  })
  for (const match of rest.matchAll(TERM)) {
    const quoted = match[2] !== undefined
    const raw = (match[2] ?? match[3] ?? "").trim()
    if (!raw) continue
    ;(match[1] === "-" ? query.excluded : query.terms).push({ raw, quoted })
  }
  return query
}

function filter(value: string, negated: boolean): Filter {
  const result: Filter = { include: [], exclude: [] }
  for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (item.startsWith("!")) result.exclude.push(item.slice(1))
    else (negated ? result.exclude : result.include).push(item)
  }
  return result
}

export function matchesFilter(filter: Filter | undefined, value: string, substring: boolean) {
  if (!filter) return true
  const test = (needle: string) => (substring ? value.toLowerCase().includes(needle.toLowerCase()) : value === needle)
  if (filter.exclude.some(test)) return false
  return !filter.include.length || filter.include.some(test)
}

const UNIT: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 }

function parseDate(raw: string, negated: boolean, now: number): DateFilter | undefined {
  const value = raw.replace(/^!/, "").toLowerCase()
  const not = negated || raw.startsWith("!")
  const startOfDay = (offset: number) => {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() + offset)
    return day.getTime()
  }
  if (value === "today") return { op: "=", cutoff: startOfDay(0), negated: not }
  if (value === "yesterday") return { op: "=", cutoff: startOfDay(-1), until: startOfDay(0), negated: not }
  if (value === "week") return { op: "<", cutoff: now - UNIT.w!, negated: not }
  if (value === "month") return { op: "<", cutoff: now - UNIT.mo!, negated: not }
  const match = value.match(/^([<>])?(\d+)(mo|m|h|d|w|y)$/)
  if (!match) return undefined
  return { op: (match[1] as "<" | ">") ?? "<", cutoff: now - Number(match[2]) * UNIT[match[3]!]!, negated: not }
}

export function matchesDate(date: DateFilter | undefined, time: number) {
  if (!date) return true
  const inside =
    date.op === ">" ? time < date.cutoff : time >= date.cutoff && (date.until === undefined || time < date.until)
  return inside !== date.negated
}
