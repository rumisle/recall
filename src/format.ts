import { homedir } from "node:os"
import type { ReadMessage, ReadPart, ReadResult } from "./read"
import type { Hit, SearchResult, SessionSummary } from "./search"

// Human- and agent-readable text for search results and transcripts. With color off (pipes, agents) the layout is
// the same, highlights become «…», and nothing depends on color to be understood.

export interface Style {
  color: boolean
  /** How to print a session id (e.g. a short unique prefix). */
  id?: (harness: string, id: string) => string
  /** A note under the summary line, e.g. the harness searched. */
  note?: string
}

const CODES = {
  bold: "1",
  dim: "2",
  italic: "3",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  mark: "1;33",
} as const

function painter(style: Style) {
  return (code: keyof typeof CODES, text: string) => (style.color && text ? `\x1b[${CODES[code]}m${text}\x1b[0m` : text)
}

// ─── search ─────────────────────────────────────────────────────────────────

export function formatSearch(result: SearchResult, offset: number, style: Style) {
  const paint = painter(style)
  const lines = [paint("dim", [`${result.total} session${result.total === 1 ? "" : "s"}`, style.note, `${result.ms.toFixed(0)} ms`].filter(Boolean).join(" · "))]
  const width = String(offset + result.results.length).length
  result.results.forEach((item, index) => {
    const session = item.session
    const number = String(offset + index + 1).padStart(width)
    const pad = " ".repeat(width + 2)
    lines.push("")
    lines.push(`${paint("dim", number + ".")} ${paint("bold", session.title || "(untitled)")}`)
    lines.push(pad + [paint("cyan", ref(session, style)), ...meta(session, style).map((text) => paint("dim", text))].join(paint("dim", " · ")))
    if (item.copies?.length)
      lines.push(pad + paint("dim", `same match in ${item.copies.map((copy) => `${ref(copy, style)} (${copy.title || "untitled"})`).join(", ")}`))
    for (const hit of item.hits) lines.push(pad + formatHit(hit, paint, style))
  })
  if (result.total > offset + result.results.length)
    lines.push("", paint("dim", `more: --offset ${offset + result.results.length}`))
  return lines.join("\n")
}

function formatHit(hit: Hit, paint: ReturnType<typeof painter>, style: Style) {
  let text = ""
  let at = 0
  for (const range of hit.ranges) {
    const matched = hit.text.slice(range.start, range.end)
    text += flat(hit.text.slice(at, range.start)) + (style.color ? paint("mark", matched) : `«${matched}»`)
    at = range.end
  }
  text = (hit.before ? "…" : "") + text.trimStart() + flat(hit.text.slice(at)).trimEnd() + (hit.after ? "…" : "")
  const where = hit.kind === "title" ? "title" : `#${hit.seq} ${label(hit.kind, hit.tool)}`
  return `${paint("magenta", where)}  ${text}`
}

function label(kind: Hit["kind"], tool?: string) {
  if (kind === "tool-call") return `${tool ?? "tool"} call`
  if (kind === "tool-result") return `${tool ?? "tool"} result`
  if (kind === "reasoning") return "thinking"
  return kind
}

const flat = (text: string) => text.replace(/\s+/g, " ")

// ─── read ───────────────────────────────────────────────────────────────────

export function formatRead(result: ReadResult, style: Style) {
  const paint = painter(style)
  const session = result.session
  const span = result.messages.length ? `#${result.from}–#${result.to - 1}` : "nothing"
  const nav = [result.from > 0 ? `earlier: --from ${Math.max(0, result.from - (result.to - result.from))}` : "", result.to < result.total ? `later: --from ${result.to}` : ""]
  const lines = [
    paint("bold", session.title || "(untitled)"),
    [paint("cyan", ref(session, style)), ...meta(session, style), session.model ?? ""].filter(Boolean).join(paint("dim", " · ")),
    paint("dim", [`showing ${span} of ${result.total}`, ...nav].filter(Boolean).join(" · ")),
  ]

  // A tool result is shown under its call when both are on the page, wherever the harness stored it.
  const results = new Map<string, { part: ReadPart; seq: number }>()
  for (const message of result.messages)
    for (const part of message.parts) if (part.kind === "tool-result" && part.call) results.set(part.call, { part, seq: message.seq })
  const placed = new Set<ReadPart>()
  for (const message of result.messages)
    for (const part of message.parts) if (part.kind === "tool-call" && part.call && results.has(part.call)) placed.add(results.get(part.call)!.part)

  let day = ""
  for (const message of result.messages) {
    const parts = message.parts.filter((part) => !placed.has(part))
    if (!parts.length) continue
    const date = new Date(message.time)
    if (message.time && dayOf(date) !== day) {
      day = dayOf(date)
      lines.push("", paint("dim", `── ${day} ──`))
    }
    lines.push("", heading(message, paint))
    let previous: ReadPart["kind"] | undefined
    for (const part of parts) {
      // A blank line between thinking, text and a run of tool calls.
      const group = part.kind === "tool-result" ? "tool-call" : part.kind
      if (previous && group !== previous) lines.push("")
      previous = group
      lines.push(...formatPart(part, message.seq, session, paint, style))
      const answer = part.kind === "tool-call" && part.call ? results.get(part.call) : undefined
      if (answer && placed.has(answer.part)) lines.push(...formatPart(answer.part, answer.seq, session, paint, style))
    }
  }
  if (result.to < result.total) lines.push("", paint("dim", `… ${result.total - result.to} more · --from ${result.to}`))
  return lines.join("\n")
}

function heading(message: ReadMessage, paint: ReturnType<typeof painter>) {
  const who = message.role === "tool" ? "tool" : message.role
  const color = who === "user" ? "green" : who === "assistant" ? "blue" : "magenta"
  return `${paint(color, paint("bold", `▌${who}`))} ${paint("dim", `#${message.seq}${message.time ? ` · ${timeOf(new Date(message.time))}` : ""}`)}`
}

function formatPart(part: ReadPart, seq: number, session: SessionSummary, paint: ReturnType<typeof painter>, style: Style): string[] {
  const more = part.omitted
    ? paint("dim", `⋯ ${part.omitted.toLocaleString("en")} more characters · recall read ${ref(session, style)} --part ${seq}.${part.index}`)
    : ""
  const body = (text: string) => {
    const clean = text.replace(/\s+$/, "")
    if (!part.omitted || part.head === undefined || part.tail === undefined) return clean ? clean.split("\n") : []
    return [...part.head.replace(/\s+$/, "").split("\n"), more, ...part.tail.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n")]
  }
  const indent = (prefix: string, rows: string[]) => rows.map((row) => prefix + row)

  switch (part.kind) {
    case "user":
    case "assistant":
      return body(part.text)
    case "reasoning":
      return indent(paint("dim", "┆ "), body(part.text).map((row) => (row === more ? row : paint("italic", paint("dim", row)))))
    case "system":
      return [paint("magenta", "◆ system"), ...indent("  ", body(part.text).map((row) => paint("dim", row)))]
    case "tool-call": {
      const [first, ...rest] = toolCall(part)
      return [`${paint("cyan", `▶ ${part.tool ?? "tool"}`)}${first ? ` ${first}` : ""}`, ...indent("  ", rest)]
    }
    case "tool-result": {
      const mark = part.error ? paint("red", `✗ ${part.tool ?? "tool"} failed`) : paint("green", "✓")
      const rows = body(part.text)
      if (!rows.length) return [`${mark} ${paint("dim", "(no output)")}`]
      if (rows.length === 1 && !part.error) return [`${mark} ${rows[0]}`]
      return [mark, ...indent("  ", rows)]
    }
  }

  // Tool input is stored as "key: value" lines (multi-line values under "key:"). Show the main argument inline:
  // a shell command as "$ cmd", a single short field as is, the rest below.
  function toolCall(call: ReadPart): string[] {
    const rows = body(call.text)
    const command = call.text.match(/^(?:command|cmd): ?(.*)$/m)
    if (command && rows.length && rows[0]!.startsWith(command[0].split(":")[0]!)) {
      const [, ...rest] = rows
      const inline = command[1]
      if (inline) return [paint("bold", `$ ${inline}`), ...rest]
      // multi-line command: the lines up to the next key
      const end = rest.findIndex((row) => /^[a-zA-Z_]+: /.test(row))
      const script = end < 0 ? rest : rest.slice(0, end)
      return [paint("bold", "$"), ...script, ...(end < 0 ? [] : rest.slice(end))]
    }
    if (rows.length === 1) return [rows[0]!]
    const simple = rows.filter((row) => /^[a-zA-Z_]+: .+/.test(row))
    if (simple.length && simple.length === rows.length) return [simple.join(paint("dim", "  ·  "))]
    return ["", ...rows]
  }
}

// ─── shared ─────────────────────────────────────────────────────────────────

function ref(session: Pick<SessionSummary, "harness" | "id">, style: Style) {
  return style.id ? style.id(session.harness, session.id) : `${session.harness}:${session.id}`
}

function meta(session: SessionSummary, style: Style) {
  return [
    ...(style.id ? [session.harness] : []),
    tilde(session.directory),
    ago(session.updated),
    `${session.messages} message${session.messages === 1 ? "" : "s"}`,
    session.archived ? "archived" : "",
    session.parent ? `child of ${ref({ harness: session.harness, id: session.parent }, style)}` : "",
  ].filter(Boolean)
}

const HOME = homedir()

function tilde(path: string) {
  return path.startsWith(HOME) ? "~" + path.slice(HOME.length) : path
}

function ago(time: number) {
  if (!time) return ""
  const minutes = (Date.now() - time) / 60e3
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 60 / 24)}d ago`
  return dayOf(new Date(time))
}

const pad = (value: number) => String(value).padStart(2, "0")
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const timeOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
