import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Adapter, Kind, Message, SessionInfo, Unchanged } from "./model"
import { tokenize } from "./tokenize"

// The index: one SQLite file, rebuilt from the agents' own stores whenever its schema version changes.
//
// Every part of every message is one row in `entry` and one document in the full-text table `fts`, plus one
// document per session for its title. The rowid encodes the session and the kind, so a search can group and filter
// on the full-text table alone:  rowid = (session * 2^25 + counter) * 8 + kind.

export const SCHEMA_VERSION = 2

export const KIND_CODE: Record<Kind | "title", number> = {
  user: 0,
  assistant: 1,
  reasoning: 2,
  "tool-call": 3,
  "tool-result": 4,
  system: 5,
  title: 6,
}
export const CODE_KIND = Object.fromEntries(Object.entries(KIND_CODE).map(([kind, code]) => [code, kind])) as Record<
  number,
  Kind | "title"
>

const SESSION_SHIFT = 2 ** 28 // 2^25 entries per session, times 8 kinds

export const sessionOf = (rowid: number) => Math.floor(rowid / SESSION_SHIFT)
export const kindOf = (rowid: number) => rowid % 8
export const rowidRange = (session: number) => [session * SESSION_SHIFT, (session + 1) * SESSION_SHIFT - 1] as const

export function defaultPath() {
  const cache = process.env.XDG_CACHE_HOME?.startsWith("/") ? process.env.XDG_CACHE_HOME : join(homedir(), ".cache")
  return join(cache, "recall", "index.db")
}

export interface Progress {
  harness: string
  done: number
  total: number
}

export class Store {
  readonly db: Database

  constructor(readonly path = defaultPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.db.run("PRAGMA busy_timeout = 10000")
    this.db.run("PRAGMA cache_size = -65536")
    this.db.run("PRAGMA journal_size_limit = 67108864")
    this.migrate()
  }

  private migrate() {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    if (version === SCHEMA_VERSION) return this.addMissing()
    this.db.transaction(() => {
      for (const table of ["session", "message", "entry", "vocab", "fts"]) this.db.run(`DROP TABLE IF EXISTS ${table}`)
      this.db.run(`CREATE TABLE session (
        num INTEGER PRIMARY KEY,
        harness TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT NOT NULL, directory TEXT NOT NULL,
        created INTEGER NOT NULL, updated INTEGER NOT NULL,
        parent TEXT, archived INTEGER, model TEXT, source TEXT NOT NULL,
        marker TEXT NOT NULL, messages INTEGER NOT NULL, counter INTEGER NOT NULL,
        UNIQUE (harness, id))`)
      this.db.run(`CREATE TABLE message (
        session INTEGER NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
        marker TEXT NOT NULL, time INTEGER NOT NULL, role TEXT NOT NULL,
        PRIMARY KEY (session, id)) WITHOUT ROWID`)
      this.db.run(`CREATE TABLE entry (
        rowid INTEGER PRIMARY KEY,
        message TEXT NOT NULL, part INTEGER NOT NULL,
        tool TEXT, call TEXT, error INTEGER,
        text NOT NULL)`) // TEXT, or zstd-compressed UTF-8 as a BLOB (see packText)
      this.db.run(`CREATE INDEX entry_message ON entry (message)`)
      // Words for typo matching: alphabetic terms of 4+ letters, keyed by first letter and length.
      this.db.run(`CREATE TABLE vocab (term TEXT PRIMARY KEY, head TEXT NOT NULL, len INTEGER NOT NULL) WITHOUT ROWID`)
      this.db.run(`CREATE INDEX vocab_head ON vocab (head, len)`)
      // body: the tokens; parts: identifier parts (CommandPalette -> command palette). Text is pre-tokenized, so
      // unicode61 only splits on the spaces.
      this.db.run(`CREATE VIRTUAL TABLE fts USING fts5(body, parts, content='', contentless_delete=1,
        tokenize="unicode61 remove_diacritics 0")`)
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })()
    this.addMissing()
  }

  // Additions that need no rebuild.
  private addMissing() {
    this.db.run("CREATE TABLE IF NOT EXISTS state (harness TEXT PRIMARY KEY, value TEXT NOT NULL)")
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(session)").all().map((row) => row.name)
    if (!columns.includes("open")) this.db.run("ALTER TABLE session ADD COLUMN open INTEGER")
  }

/**
   * Bring the index up to date with every adapter's store. Returns the number of sessions read again. `full` makes
   * adapters check everything instead of only what their shortcuts say may have changed.
   */
  async refresh(adapters: Adapter[], onProgress?: (progress: Progress) => void, options: { full?: boolean } = {}) {
    let changed = 0
    for (const adapter of adapters) {
      const state = this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE harness = ?").get(adapter.harness)?.value
      const open = new Set(
        this.db.query<{ id: string }, [string]>("SELECT id FROM session WHERE harness = ? AND open = 1").all(adapter.harness).map((row) => row.id),
      )
      const listed = await adapter.list({ state, full: options.full ?? false, open })
      if (!listed) continue
      const listing = listed.sessions
      const listedIDs = new Set(listing.map((item) => item.id))
      const indexed = new Map(
        this.db
          .query<{ id: string; marker: string; num: number }, [string]>("SELECT id, marker, num FROM session WHERE harness = ?")
          .all(adapter.harness)
          .map((row) => [row.id, row]),
      )
      const stale = listing.filter((item) => item.dirty || indexed.get(item.id)?.marker !== item.marker)
      const gone = [...indexed.values()].filter((row) => !listedIDs.has(row.id))
      for (const row of gone) this.db.transaction(() => this.deleteSession(row.num))()
      let done = 0
      for (const item of stale) {
        const num = indexed.get(item.id)?.num
        const known = num === undefined ? new Map<string, string>() : this.messageMarkers(num)
        const transcript = await adapter.load(item.id, known)
        // Another process may have indexed it meanwhile (the server and a CLI call refreshing at once); write only
        // if the index is still as it was when the transcript was loaded.
        if (transcript)
          this.db
            .transaction(() => {
              const current = this.db
                .query<{ num: number; marker: string }, [string, string]>("SELECT num, marker FROM session WHERE harness = ? AND id = ?")
                .get(adapter.harness, item.id)
              if ((current?.marker === item.marker && !item.dirty) || current?.num !== num) return
              if (num !== undefined && !sameMarkers(this.messageMarkers(num), known)) return
              this.write(transcript.session, transcript.messages, item.marker, num, known, transcript.open)
            })
            .immediate()
        done++
        onProgress?.({ harness: adapter.harness, done, total: stale.length })
      }
      changed += stale.length + gone.length
      if (listed.state !== undefined)
        this.db.run("INSERT INTO state (harness, value) VALUES (?, ?) ON CONFLICT (harness) DO UPDATE SET value = excluded.value", [adapter.harness, listed.state])
    }
    // After a big refresh (the first one, a rebuild) merge the index segments: smaller and faster to query.
    if (changed >= 100) {
      this.db.run("INSERT INTO fts (fts) VALUES ('optimize')")
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    }
    return changed
  }

  private messageMarkers(session: number) {
    return new Map(
      this.db
        .query<{ id: string; marker: string }, [number]>("SELECT id, marker FROM message WHERE session = ?")
        .all(session)
        .map((row) => [row.id, row.marker]),
    )
  }

  private write(info: SessionInfo, messages: (Message | Unchanged)[], marker: string, num: number | undefined, known: Map<string, string>, open?: boolean) {
    const session =
      num ??
      this.db
        .query<{ num: number }, [string, string]>(
          `INSERT INTO session (harness, id, title, directory, created, updated, source, marker, messages, counter)
           VALUES (?, ?, '', '', 0, 0, '', '', 0, 0) RETURNING num`,
        )
        .get(info.harness, info.id)!.num
    const titleChanged =
      num === undefined ||
      this.db.query<{ title: string }, [number]>("SELECT title FROM session WHERE num = ?").get(session)?.title !== info.title
    let counter = this.db.query<{ counter: number }, [number]>("SELECT counter FROM session WHERE num = ?").get(session)!.counter

    const seen = new Set<string>()
    const upsertMessage = this.db.query(
      `INSERT INTO message (session, id, seq, marker, time, role) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session, id) DO UPDATE SET seq = excluded.seq, marker = excluded.marker, time = excluded.time, role = excluded.role`,
    )
    const reseq = this.db.query("UPDATE message SET seq = ? WHERE session = ? AND id = ? AND seq != ?")
    const insertEntry = this.db.query("INSERT INTO entry (rowid, message, part, tool, call, error, text) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const insertFts = this.db.query("INSERT INTO fts (rowid, body, parts) VALUES (?, ?, ?)")
    const insertVocab = this.db.query("INSERT OR IGNORE INTO vocab (term, head, len) VALUES (?, ?, ?)")
    const vocab = new Set<string>()

    const add = (code: number, message: string, part: number, text: string, extra: { tool?: string; call?: string; error?: boolean }) => {
      const rowid = (session * 2 ** 25 + counter++) * 8 + code
      insertEntry.run(rowid, message, part, extra.tool ?? null, extra.call ?? null, extra.error ? 1 : null, packText(text))
      const tokens = tokenize(text)
      const body: string[] = []
      const parts: string[] = []
      for (const token of tokens) {
        ;(token.part ? parts : body).push(token.text)
        if (token.text.length >= 4 && token.text.length <= 24 && /^\p{L}+$/u.test(token.text)) vocab.add(token.text)
      }
      insertFts.run(rowid, body.join(" "), parts.join(" "))
    }

    messages.forEach((message, seq) => {
      seen.add(message.id)
      if ("unchanged" in message) {
        reseq.run(seq, session, message.id, seq)
        return
      }
      const markerText = message.marker ?? String(Bun.hash(JSON.stringify(message.parts)))
      if (known.get(message.id) === markerText) {
        reseq.run(seq, session, message.id, seq)
        return
      }
      if (known.has(message.id)) this.deleteEntries(session, message.id)
      upsertMessage.run(session, message.id, seq, markerText, message.time, message.role)
      message.parts.forEach((part, index) =>
        add(KIND_CODE[part.kind], message.id, index, part.text, { tool: part.tool, call: part.callID, error: part.error }),
      )
    })
    for (const id of known.keys()) {
      if (seen.has(id)) continue
      this.deleteEntries(session, id)
      this.db.run("DELETE FROM message WHERE session = ? AND id = ?", [session, id])
    }
    if (titleChanged) {
      const [low, high] = rowidRange(session)
      const old = this.db
        .query<{ rowid: number }, [number, number]>("SELECT rowid FROM entry WHERE rowid BETWEEN ? AND ? AND rowid % 8 = 6")
        .all(low, high)
      for (const row of old) this.deleteRow(row.rowid)
      if (info.title) add(KIND_CODE.title, "", 0, info.title, {})
    }
    for (const term of vocab) insertVocab.run(term, term[0]!, term.length)
    this.db.run(
      `UPDATE session SET title = ?, directory = ?, created = ?, updated = ?, parent = ?, archived = ?, model = ?, source = ?,
         marker = ?, messages = (SELECT count(*) FROM message WHERE session = ?), counter = ?, open = ? WHERE num = ?`,
      [
        info.title,
        info.directory,
        info.created,
        info.updated,
        info.parent ?? null,
        info.archived ?? null,
        info.model ?? null,
        info.source,
        marker,
        session,
        counter,
        open ? 1 : null,
        session,
      ],
    )
  }

  private deleteEntries(session: number, message: string) {
    const [low, high] = rowidRange(session)
    const rows = this.db
      .query<{ rowid: number }, [string, number, number]>("SELECT rowid FROM entry WHERE message = ? AND rowid BETWEEN ? AND ?")
      .all(message, low, high)
    for (const row of rows) this.deleteRow(row.rowid)
  }

  private deleteRow(rowid: number) {
    this.db.run("DELETE FROM fts WHERE rowid = ?", [rowid])
    this.db.run("DELETE FROM entry WHERE rowid = ?", [rowid])
  }

  private deleteSession(num: number) {
    const [low, high] = rowidRange(num)
    this.db.run("DELETE FROM fts WHERE rowid BETWEEN ? AND ?", [low, high])
    this.db.run("DELETE FROM entry WHERE rowid BETWEEN ? AND ?", [low, high])
    this.db.run("DELETE FROM message WHERE session = ?", [num])
    this.db.run("DELETE FROM session WHERE num = ?", [num])
  }

  close() {
    this.db.close()
  }
}

/** Long texts are stored zstd-compressed (about half the size). */
export function packText(text: string): string | Uint8Array {
  return text.length > 256 ? Bun.zstdCompressSync(Buffer.from(text)) : text
}

export function unpackText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Bun.zstdDecompressSync(value).toString()
}

function sameMarkers(a: Map<string, string>, b: Map<string, string>) {
  if (a.size !== b.size) return false
  for (const [id, marker] of a) if (b.get(id) !== marker) return false
  return true
}
