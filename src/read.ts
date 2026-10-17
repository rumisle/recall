import type { Kind } from "./model"
import { CODE_KIND, KIND_CODE, kindOf, rowidRange, unpackText, type Store } from "./store"
import type { SessionSummary } from "./search"

export interface ReadOptions {
  /** First message (seq, from 0; negative counts from the end). Default 0, or `around - context`. */
  from?: number
  /** Number of messages. Default 20. */
  count?: number
  /** Center on this message, with `context` messages on each side. */
  around?: number
  context?: number
  /** Only these kinds of parts. */
  kinds?: Set<Kind>
  /** Longest part shown in full; longer parts are cut in the middle. Default 4000. 0 = no limit. */
  maxPart?: number
}

export interface ReadPart {
  kind: Kind
  /** Index within the message. */
  index: number
  tool?: string
  call?: string
  error?: boolean
  /** The whole text, or when cut, the beginning and the end (`head` + `tail`). */
  text: string
  head?: string
  tail?: string
  /** Characters left out between head and tail. */
  omitted: number
  length: number
}

export interface ReadMessage {
  seq: number
  id: string
  role: string
  time: number
  parts: ReadPart[]
}

export interface ReadResult {
  session: SessionSummary & { source: string }
  messages: ReadMessage[]
  /** Range shown, and whether there is more before or after. */
  from: number
  to: number
  total: number
}

interface SessionRow extends Omit<SessionSummary, "parent" | "archived" | "model"> {
  num: number
  parent: string | null
  archived: number | null
  model: string | null
  source: string
}

/** Find a session by "harness:id", an id, or a unique id prefix. */
export function findSession(store: Store, ref: string): SessionRow | undefined {
  const [harness, id] = ref.includes(":") && !ref.startsWith("/") ? [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)] : [undefined, ref]
  const rows = store.db
    .query<SessionRow, [string, string | null]>(
      `SELECT num, harness, id, title, directory, created, updated, parent, archived, model, messages, source FROM session
       WHERE substr(id, 1, length(?1)) = ?1 AND (?2 IS NULL OR harness = ?2)
       ORDER BY id = ?1 DESC, updated DESC LIMIT 2`,
    )
    .all(id!, harness ?? null)
  if (!rows.length) return undefined
  if (rows[0]!.id === id || rows.length === 1) return rows[0]
  return undefined
}

export function read(store: Store, ref: string, options: ReadOptions = {}): ReadResult | undefined {
  const row = findSession(store, ref)
  if (!row) return undefined
  const total = row.messages
  const count = options.count ?? 20
  const context = options.context ?? 5
  const fromRaw = options.around !== undefined ? options.around - context : (options.from ?? 0)
  const from = Math.max(0, fromRaw < 0 && options.around === undefined ? total + fromRaw : fromRaw)
  const to = Math.min(total, options.around !== undefined && options.count === undefined ? options.around + context + 1 : from + count)
  const maxPart = options.maxPart ?? 4000

  const messages = store.db
    .query<{ id: string; seq: number; role: string; time: number }, [number, number, number]>(
      "SELECT id, seq, role, time FROM message WHERE session = ? AND seq >= ? AND seq < ? ORDER BY seq",
    )
    .all(row.num, from, to)
  const [low, high] = rowidRange(row.num)
  const kinds = options.kinds ? [...options.kinds].map((kind) => KIND_CODE[kind]) : undefined
  const partsOf = store.db.query<
    { rowid: number; part: number; tool: string | null; call: string | null; error: number | null; text: string | Uint8Array },
    [string, number, number]
  >(
    `SELECT rowid, part, tool, call, error, text FROM entry WHERE message = ? AND rowid BETWEEN ? AND ?
     ${kinds ? `AND rowid % 8 IN (${kinds.join(",")})` : ""} ORDER BY part`,
  )
  return {
    session: {
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
      source: row.source,
    },
    messages: messages.map((message) => ({
      ...message,
      parts: partsOf.all(message.id, low, high).map((row) => {
        const part = { ...row, text: unpackText(row.text) }
        const cut = maxPart > 0 && part.text.length > maxPart ? cutMiddle(part.text, maxPart) : undefined
        return {
          kind: CODE_KIND[kindOf(part.rowid)] as Kind,
          index: part.part,
          tool: part.tool ?? undefined,
          call: part.call ?? undefined,
          error: part.error ? true : undefined,
          text: cut ? cut.head + cut.tail : part.text,
          head: cut?.head,
          tail: cut?.tail,
          omitted: cut ? part.text.length - cut.head.length - cut.tail.length : 0,
          length: part.text.length,
        }
      }),
    })),
    from,
    to,
    total,
  }
}

/** About 60% of `max` from the start and 40% from the end, cut at line breaks (or spaces) near those points. */
function cutMiddle(text: string, max: number) {
  const headEnd = snap(text, Math.ceil(max * 0.6), -1)
  const tailStart = snap(text, text.length - Math.floor(max * 0.4), 1)
  return { head: text.slice(0, headEnd), tail: text.slice(Math.max(tailStart, headEnd)) }
}

// The nearest line break (else space) within a fifth of the distance, searching backward (-1) or forward (1).
function snap(text: string, at: number, direction: -1 | 1) {
  const reach = Math.max(40, Math.floor(at * 0.2))
  for (const separator of ["\n", " "]) {
    const found = direction < 0 ? text.lastIndexOf(separator, at) : text.indexOf(separator, at)
    if (found >= 0 && Math.abs(found - at) <= reach) return direction < 0 ? found : found + 1
  }
  return at
}

/** One part, whole or a character window of it. */
export function readPart(store: Store, ref: string, seq: number, index: number, offset = 0, length?: number) {
  const row = findSession(store, ref)
  if (!row) return undefined
  const message = store.db
    .query<{ id: string }, [number, number]>("SELECT id FROM message WHERE session = ? AND seq = ?")
    .get(row.num, seq)
  if (!message) return undefined
  const [low, high] = rowidRange(row.num)
  const part = store.db
    .query<{ text: string | Uint8Array; tool: string | null; rowid: number }, [string, number, number, number]>(
      "SELECT rowid, text, tool FROM entry WHERE message = ? AND part = ? AND rowid BETWEEN ? AND ?",
    )
    .get(message.id, index, low, high)
  if (!part) return undefined
  const text = unpackText(part.text)
  const end = length === undefined ? text.length : offset + length
  return { kind: CODE_KIND[kindOf(part.rowid)], tool: part.tool ?? undefined, text: text.slice(offset, end), offset, length: text.length }
}
