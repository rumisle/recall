import type { Store } from "./store"

/**
 * Shortest unique prefixes of session ids (at least 8 characters), to print instead of the full ids. `read` and
 * `session:` accept any unique prefix. An id present in two stores (a database copied from another channel) gets
 * its harness in front: "ocelot:ses_4f2a9134".
 */
export function shortIds(store: Store) {
  const rows = store.db.query<{ harness: string; id: string }, []>("SELECT harness, id FROM session ORDER BY id").all()
  const ids = [...new Set(rows.map((row) => row.id))]
  const twice = new Set(rows.filter((row, i) => rows[i - 1]?.id === row.id).map((row) => row.id))
  const lengths = new Map(
    ids.map((id, i) => [id, Math.min(id.length, Math.max(8, common(id, ids[i - 1]) + 1, common(id, ids[i + 1]) + 1))]),
  )
  return (harness: string, id: string) => {
    const short = id.slice(0, lengths.get(id) ?? id.length)
    return twice.has(id) ? `${harness}:${short}` : short
  }
}

function common(a: string, b: string | undefined) {
  if (!b) return 0
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return i
}

/** The agent session this process runs in, from the variables each harness sets for its shell commands. */
export function caller(env = process.env): { harness?: string; session?: string } {
  if (env.OPENCODE_SESSION_ID) return { session: env.OPENCODE_SESSION_ID } // ocelot or opencode: found by id
  if (env.PI_SESSION_ID || env.AI_AGENT === "pi") return { harness: "pi", session: env.PI_SESSION_ID }
  if (env.CODEX_THREAD_ID) return { harness: "codex", session: env.CODEX_THREAD_ID }
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return { harness: "claude", session: env.CLAUDE_CODE_SESSION_ID }
  return {}
}
