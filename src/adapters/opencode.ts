import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import type { Adapter, Listing, Message, Part, SessionInfo, Transcript, Unchanged } from "../model"
import { renderInput } from "./shared"

// OpenCode 2 (and ocelot, which shares its schema): sessions in `session_v2`, one row per message in
// `session_message` with the message as JSON in `data`. Read-only; the server keeps writing in WAL mode meanwhile.

export function opencode(harness: string, path: string): Adapter {
  let db: Database | undefined
  const open = () => {
    if (db) return db
    if (!existsSync(path)) return undefined
    db = new Database(path, { readonly: true })
    db.run("PRAGMA busy_timeout = 2000")
    return db
  }

  return {
    harness,
    async list() {
      const conn = open()
      if (!conn) return undefined
      const rows = conn
        .query<{ id: string; updated: number; archived: number | null; title: string | null; last: number | null; n: number }, []>(
          `select s.id, s.time_updated updated, s.time_archived archived, s.title,
             (select max(m.time_updated) from session_message m where m.session_id = s.id) last,
             (select count(*) from session_message m where m.session_id = s.id) n
           from session_v2 s`,
        )
        .all()
      return rows.map(
        (row): Listing => ({ id: row.id, marker: [row.updated, row.archived, row.title, row.last, row.n].join(":") }),
      )
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
      const heads = conn
        .query<{ id: string; type: string; updated: number }, [string]>(
          `select id, type, time_updated updated from session_message where session_id = ? order by seq`,
        )
        .all(id)
      const changed = heads.filter((head) => known.get(head.id) !== String(head.updated)).map((head) => head.id)
      const data = new Map<string, string>()
      const select = conn.query<{ id: string; data: string }, [string]>(`select id, data from session_message where id = ?`)
      for (const messageID of changed) {
        const message = select.get(messageID)
        if (message) data.set(message.id, message.data)
      }
      const messages = heads.flatMap((head): (Message | Unchanged)[] => {
        const raw = data.get(head.id)
        if (raw === undefined) return [{ id: head.id, unchanged: true }]
        const message = toMessage(head.id, head.type, JSON.parse(raw))
        if (!message) return []
        message.marker = String(head.updated)
        return [message]
      })
      const model = row.model ? JSON.parse(row.model) : undefined
      const session: SessionInfo = {
        harness,
        id: row.id,
        title: row.title ?? "",
        directory: row.directory,
        created: row.time_created,
        updated: Math.max(row.time_updated, conn.query<{ last: number | null }, [string]>("select max(time_updated) last from session_message where session_id = ?").get(id)?.last ?? 0),
        parent: row.parent_id ?? undefined,
        archived: row.time_archived ?? undefined,
        model: model ? `${model.providerID}/${model.id}` : undefined,
        source: path,
      }
      return { session, messages } satisfies Transcript
    },
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
