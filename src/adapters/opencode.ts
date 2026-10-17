import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import type { Adapter, Listing, Message, Part, SessionInfo, Transcript, Unchanged } from "../model"
import { renderInput } from "./shared"

// OpenCode 2 (and ocelot, which shares its schema): sessions in `session_v2`, one row per message in
// `session_message` with the message as JSON in `data`. Read-only; the server keeps writing in WAL mode meanwhile.
//
// The database is large and may sit on a network filesystem, where every page read is a round trip, so a refresh
// avoids reading message rows. Nothing indexes time_updated, and session_v2.time_updated does not follow new
// messages, so changes are found from the time_created index instead: a session is read again when it has messages
// created since the last refresh, or was mid-turn then (a running step updates its message without creating new
// ones). Within it, the message list comes from covering indexes; only new messages, those created since the last
// refresh and those of the open turn have their row read, and their data only if time_updated changed. Edits to
// older messages (rare) are caught by a full check every week, or `recall refresh --full`.

const DAY = 86400e3
const FULL_EVERY = 7 * DAY
// Clock differences, and writes committed after the last refresh looked although created before it.
const SLACK = 5 * 60e3

interface State {
  /** When the last refresh began. */
  since: number
  /** When the last full check began. */
  full: number
}

export function opencode(harness: string, path: string): Adapter {
  let db: Database | undefined
  // Set by list() for the load() calls of the same refresh; undefined means compare every message.
  let since: number | undefined
  const open = () => {
    if (db) return db
    if (!existsSync(path)) return undefined
    db = new Database(path, { readonly: true })
    db.run("PRAGMA busy_timeout = 2000")
    db.run("PRAGMA mmap_size = 1073741824")
    return db
  }

  return {
    harness,
    async list(context) {
      const conn = open()
      if (!conn) return undefined
      const started = Date.now()
      const previous = parseState(context.state)
      const full = context.full || !previous || started - previous.full > FULL_EVERY
      since = full || !previous ? undefined : previous.since - SLACK
      const recent =
        since === undefined
          ? undefined
          : new Set(
              conn
                .query<{ id: string }, [number]>(
                  "select distinct session_id id from session_message indexed by session_message_time_created_idx where time_created > ?",
                )
                .all(since)
                .map((row) => row.id),
            )
      const rows = conn
        .query<{ id: string; updated: number; archived: number | null; title: string | null }, []>(
          "select id, time_updated updated, time_archived archived, title from session_v2",
        )
        .all()
      const state: State = { since: started, full: full ? started : previous!.full }
      return {
        sessions: rows.map(
          (row): Listing => ({
            id: row.id,
            marker: [row.updated, row.archived, row.title].join(":"),
            dirty: !recent || recent.has(row.id) || context.open.has(row.id),
          }),
        ),
        state: JSON.stringify(state),
      }
    },
    async load(id, known) {
      const conn = open()
      if (!conn) return undefined
      const row = conn
        .query<SessionRow, [string]>(
          `select id, parent_id, directory, title, time_created, time_updated, time_archived, model from session_v2 where id = ?`,
        )
        .get(id)
      if (!row) return undefined
      // Index-only reads: every message's id, creation time and position, and the last idle marker (turn end).
      const positions = new Map(
        conn
          .query<{ r: number; seq: number }, [string]>("select rowid r, seq from session_message where session_id = ?")
          .all(id)
          .map((item) => [item.r, item.seq]),
      )
      const heads = conn
        .query<{ r: number; id: string; created: number }, [string]>(
          "select rowid r, id, time_created created from session_message where session_id = ?",
        )
        .all(id)
        .map((item) => ({ ...item, seq: positions.get(item.r) ?? 0 }))
        .sort((x, y) => x.seq - y.seq)
      const idle =
        conn
          .query<{ seq: number | null }, [string]>("select max(seq) seq from session_message where session_id = ? and type = 'idle'")
          .get(id)?.seq ?? -1
      const check = heads.filter(
        (head) => since === undefined || !known.has(head.id) || head.created > since || head.seq > idle,
      )
      const meta = conn.query<{ type: string; updated: number }, [string]>("select type, time_updated updated from session_message where id = ?")
      const body = conn.query<{ data: string }, [string]>("select data from session_message where id = ?")
      const read = new Map<string, Message>()
      let updated = row.time_updated
      for (const head of check) {
        const found = meta.get(head.id)
        if (!found) continue
        updated = Math.max(updated, found.updated)
        if (known.get(head.id) === String(found.updated)) continue
        const raw = body.get(head.id)?.data
        if (raw === undefined) continue
        const message = toMessage(head.id, found.type, JSON.parse(raw)) ?? { id: head.id, time: head.created, role: "system", parts: [] }
        message.marker = String(found.updated)
        read.set(head.id, message)
      }
      const last = heads.at(-1)
      const model = row.model ? JSON.parse(row.model) : undefined
      const session: SessionInfo = {
        harness,
        id: row.id,
        title: row.title ?? "",
        directory: row.directory,
        created: row.time_created,
        updated: Math.max(updated, last?.created ?? 0),
        parent: row.parent_id ?? undefined,
        archived: row.time_archived ?? undefined,
        model: model ? `${model.providerID}/${model.id}` : undefined,
        source: path,
      }
      return {
        session,
        messages: heads.map((head): Message | Unchanged => read.get(head.id) ?? { id: head.id, unchanged: true }),
        // Mid-turn: messages after the last idle marker, recently. A session that ended without one (a shutdown
        // records none) stops counting after a day.
        open: last !== undefined && last.seq > idle && last.created > Date.now() - DAY,
      } satisfies Transcript
    },
  }
}

function parseState(value: string | undefined): State | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed?.since === "number" && typeof parsed?.full === "number" ? parsed : undefined
  } catch {
    return undefined
  }
}

interface SessionRow {
  id: string
  parent_id: string | null
  directory: string
  title: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
  model: string | null
}

// The message JSON is the encoded SessionMessage.Info (packages/schema/src/session-message.ts) without type and id.
// Shapes vary across versions, so read leniently.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

function toMessage(id: string, type: string, data: Json): Message | undefined {
  const time = data.time?.created ?? 0
  const system = (text: string | undefined, label: string): Message | undefined =>
    text ? { id, time, role: "system", parts: [{ kind: "system", text: `[${label}]\n${text}` }] } : undefined
  switch (type) {
    case "user": {
      const files = (data.files ?? []).map((file: Json) => `[file: ${file.name ?? file.source?.path ?? file.mime}]`)
      const text = [data.text ?? "", ...files].filter(Boolean).join("\n")
      return { id, time, role: "user", parts: [{ kind: "user", text }] }
    }
    case "assistant":
      return { id, time, role: "assistant", parts: (data.content ?? []).flatMap(assistantParts) }
    case "synthetic":
      return system(data.text, data.description ?? "synthetic")
    case "system":
      return system(data.text, data.description ?? "system")
    case "skill":
      return system(data.text, `skill ${data.name ?? ""}`.trim())
    case "compaction":
      return data.status === "completed" ? system(data.summary, "compaction summary") : undefined
    case "notice":
      return system(data.text, `notice from ${data.source}`)
    case "shell": {
      return {
        id,
        time,
        role: "user",
        parts: [
          { kind: "tool-call", tool: "shell", callID: id, text: data.command ?? "" },
          { kind: "tool-result", tool: "shell", callID: id, text: data.output?.output ?? "" },
        ],
      }
    }
    default:
      return undefined
  }
}

function assistantParts(part: Json): Part[] {
  if (part.type === "text") return part.text ? [{ kind: "assistant", text: part.text }] : []
  if (part.type === "reasoning") return part.text ? [{ kind: "reasoning", text: part.text }] : []
  if (part.type !== "tool") return []
  const state = part.state ?? {}
  const input = typeof state.input === "string" ? state.input : renderInput(state.input)
  const call: Part = { kind: "tool-call", tool: part.name, callID: part.id, text: input }
  const content = (state.content ?? [])
    .map((item: Json) => (typeof item.text === "string" ? item.text : `[${item.type}${item.mime ? ` ${item.mime}` : ""}]`))
    .join("\n")
  if (state.status === "error") {
    const error = state.error?.message ?? state.error?.data?.message ?? JSON.stringify(state.error)
    return [call, { kind: "tool-result", tool: part.name, callID: part.id, error: true, text: [error, content].filter(Boolean).join("\n") }]
  }
  if (state.status !== "completed") return [call]
  return [call, { kind: "tool-result", tool: part.name, callID: part.id, text: content }]
}
