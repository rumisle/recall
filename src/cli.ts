#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { defaultAdapters } from "./adapters"
import { KINDS, type Kind } from "./model"
import { formatRead, formatSearch } from "./format"
import { caller, shortIds } from "./ids"
import { read, readPart } from "./read"
import { search } from "./search"
import { Store } from "./store"

const HELP = `recall: search and read past agent sessions (ocelot, opencode, Claude Code, Codex, pi)

  recall [search] QUERY        sessions matching QUERY, best first, with excerpts
      --limit N (20)  --offset N  --hits N (3) per session  --context N (120) chars
  recall read SESSION          a transcript: user, assistant, reasoning, tool calls and results
      --from N (0; negative counts from the end)  --count N (20)
      --around N  --context N (5)                 messages around one (e.g. a search hit's #N)
      --in KINDS                                  user,assistant,reasoning,tool,call,result,system
      --max-part N (4000)                         longer parts are cut in the middle; 0 = never
  recall read SESSION --part N.I [--offset N] [--length N]   one part in full (message N, part I)
  recall refresh               update the index (search and read do it first anyway)

  Options: --json  --no-refresh  --db PATH (or RECALL_DB)
           --all   run from an agent, search covers only that agent's harness unless the query has agent:
                   or --all is given

Query syntax:
  words               all must appear; longer words also match by prefix and with one typo
  "exact phrase"      in this order, no typos;  -word  leaves out sessions with it
  agent:claude,codex  -agent:pi       harness: ocelot opencode claude codex pi
  dir:backend         directory contains          date:<2d >1w today yesterday week month
  in:reasoning,user   only these parts (tool = call + result; also title, system)
  is:archived  -is:child              archived sessions are included but rank lower
  session:ID          search within one session (session:self = the calling agent's own)

SESSION is an id or unique id prefix as printed by search (harness:id when needed), or self.`

// "--from -20": parseArgs takes a value starting with "-" for an option, so join it as "--from=-20".
const args = Bun.argv.slice(2).flatMap((arg, i, all) => (/^-\d/.test(arg) && /^--\w/.test(all[i - 1] ?? "") ? [] : /^--\w/.test(arg) && /^-\d/.test(all[i + 1] ?? "") ? [`${arg}=${all[i + 1]}`] : [arg]))

const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    offset: { type: "string" },
    hits: { type: "string" },
    context: { type: "string" },
    from: { type: "string" },
    count: { type: "string" },
    around: { type: "string" },
    in: { type: "string" },
    "max-part": { type: "string" },
    part: { type: "string" },
    length: { type: "string" },
    json: { type: "boolean" },
    all: { type: "boolean" },
    "no-refresh": { type: "boolean" },
    db: { type: "string" },
    quiet: { type: "boolean", short: "q" },
    help: { type: "boolean", short: "h" },
  },
})

const number = (value: string | undefined) => (value === undefined ? undefined : Number(value))
const color = process.stdout.isTTY && !process.env.NO_COLOR

const [command, ...rest] = ["search", "read", "refresh", "help"].includes(positionals[0] ?? "") ? positionals : ["search", ...positionals]

if (values.help || command === "help") {
  console.log(HELP)
  process.exit(0)
}

const store = new Store(values.db ?? process.env.RECALL_DB ?? undefined)
if (!values["no-refresh"] || command === "refresh") {
  const started = performance.now()
  let last = 0
  const changed = await store.refresh(defaultAdapters(), (progress) => {
    if (!process.stderr.isTTY || values.quiet || performance.now() - last < 200) return
    last = performance.now()
    process.stderr.write(`\rindexing ${progress.harness} ${progress.done}/${progress.total}\x1b[K`)
  })
  if (process.stderr.isTTY && last) process.stderr.write("\r\x1b[K")
  if (command === "refresh" && !values.quiet) console.error(`${changed} sessions updated in ${((performance.now() - started) / 1000).toFixed(1)}s`)
}

// Inside an agent: its harness (found from its session id when the harness shares OpenCode's variables) and
// session, for the default scope and "self".
const me = caller()
const myHarness =
  me.harness ??
  (me.session
    ? store.db.query<{ harness: string }, [string]>("SELECT harness FROM session WHERE id = ? ORDER BY updated DESC").get(me.session)?.harness
    : undefined)
const self = me.session && myHarness ? `${myHarness}:${me.session}` : undefined
const style = { color, id: values.json ? undefined : shortIds(store) }

if (command === "search") {
  let query = rest.join(" ")
  if (/(^|\s)session:self\b/.test(query)) {
    if (!self) fail("session:self: not running inside a known agent session")
    query = query.replace(/(^|\s)session:self\b/, `$1session:${me.session}`)
  }
  const scoped = myHarness && !values.all && !/(^|\s)-?(agent|harness):/.test(query)
  if (scoped) query = `agent:${myHarness} ${query}`
  const result = search(store, query, {
    limit: number(values.limit),
    offset: number(values.offset),
    hits: number(values.hits),
    context: number(values.context),
  })
  console.log(values.json ? JSON.stringify(result, null, 2) : formatSearch(result, number(values.offset) ?? 0, { ...style, note: scoped ? `${myHarness} only (--all for every harness)` : undefined }))
}

if (command === "read") {
  const ref = rest[0] === "self" ? self : rest[0]
  if (!ref) fail(rest[0] === "self" ? "read self: not running inside a known agent session" : "read: which session?")
  if (values.part) {
    const [seq, index] = values.part.split(".").map(Number)
    const part = readPart(store, ref, seq!, index ?? 0, number(values.offset), number(values.length))
    if (!part) fail(`no part ${values.part} in ${ref}`)
    console.log(values.json ? JSON.stringify(part, null, 2) : part.text)
  } else {
    const kinds = values.in ? kindsOf(values.in) : undefined
    const result = read(store, ref, {
      from: number(values.from),
      count: number(values.count),
      around: number(values.around),
      context: number(values.context),
      kinds,
      maxPart: number(values["max-part"]),
    })
    if (!result) {
      const id = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref
      const candidates = search(store, `session:${id}`, { limit: 10, hits: 0 }).results
      if (!candidates.length) fail(`no session ${ref}`)
      fail(`${ref} matches several sessions:\n${candidates.map((item) => `  ${item.session.harness}:${item.session.id}  ${item.session.title}`).join("\n")}`)
    }
    console.log(values.json ? JSON.stringify(result, null, 2) : formatRead(result, style))
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function kindsOf(value: string) {
  const aliases: Record<string, Kind[]> = { tool: ["tool-call", "tool-result"], call: ["tool-call"], result: ["tool-result"], thinking: ["reasoning"] }
  return new Set(value.split(",").flatMap((name) => aliases[name] ?? (KINDS.includes(name as Kind) ? [name as Kind] : [])))
}

