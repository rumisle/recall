import { describe, expect, test } from "bun:test"
import type { Adapter, Message, SessionInfo, Transcript } from "../src/model"
import { caller, shortIds } from "../src/ids"
import { read, readPart } from "../src/read"
import { search } from "../src/search"
import { Store } from "../src/store"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const DAY = 86400e3

/** An in-memory store of sessions; change it and refresh. */
function fake(harness = "fake") {
  const sessions = new Map<string, Transcript>()
  let version = 0
  const markers = new Map<string, number>()
  const adapter: Adapter = {
    harness,
    async list() {
      return { sessions: [...sessions.keys()].map((id) => ({ id, marker: String(markers.get(id)) })) }
    },
    async load(id) {
      const found = sessions.get(id)
      return found && structuredClone(found)
    },
  }
  const put = (id: string, info: Partial<SessionInfo>, messages: Message[]) => {
    sessions.set(id, {
      session: { harness, id, title: "", directory: "/work/project", created: NOW - DAY, updated: NOW - DAY, source: "test", ...info },
      messages,
    })
    markers.set(id, ++version)
  }
  return { adapter, put, remove: (id: string) => sessions.delete(id) }
}

const user = (id: string, text: string, time = NOW - DAY): Message => ({ id, time, role: "user", parts: [{ kind: "user", text }] })
const assistant = (id: string, parts: Message["parts"], time = NOW - DAY): Message => ({ id, time, role: "assistant", parts })

const titles = (store: Store, query: string) => search(store, query, { now: NOW }).results.map((result) => result.session.title)

describe("index", () => {
  test("refresh is incremental, and follows edits and deletions", async () => {
    const store = new Store(":memory:")
    const source = fake()
    source.put("a", { title: "first" }, [user("m1", "hello world"), assistant("m2", [{ kind: "assistant", text: "greetings" }])])
    expect(await store.refresh([source.adapter])).toBe(1)
    expect(await store.refresh([source.adapter])).toBe(0)
    expect(titles(store, "greetings")).toEqual(["first"])

    source.put("a", { title: "renamed" }, [user("m1", "hello world"), assistant("m2", [{ kind: "assistant", text: "farewell" }])])
    await store.refresh([source.adapter])
    expect(titles(store, "greetings")).toEqual([])
    expect(titles(store, "farewell")).toEqual(["renamed"])
    expect(titles(store, "first")).toEqual([])
    const count = () => store.db.query<{ n: number }, []>("SELECT count(*) n FROM entry").get()!.n
    expect(count()).toBe(3) // two parts and the title

    source.put("a", { title: "renamed" }, [user("m1", "hello world")])
    await store.refresh([source.adapter])
    expect(titles(store, "farewell")).toEqual([])
    expect(count()).toBe(2)

    source.remove("a")
    await store.refresh([source.adapter])
    expect(titles(store, "hello")).toEqual([])
    expect(count()).toBe(0)
  })

  test("every kind of part is searchable and filterable", async () => {
    const store = new Store(":memory:")
    const source = fake()
    source.put("a", { title: "kinds" }, [
      user("m1", "alpha"),
      assistant("m2", [
        { kind: "reasoning", text: "bravo" },
        { kind: "tool-call", tool: "shell", text: "command: charlie" },
        { kind: "tool-result", tool: "shell", text: "delta" },
      ]),
    ])
    await store.refresh([source.adapter])
    for (const word of ["alpha", "bravo", "charlie", "delta", "kinds"]) expect(titles(store, word)).toEqual(["kinds"])
    expect(titles(store, "in:reasoning bravo")).toEqual(["kinds"])
    expect(titles(store, "in:user bravo")).toEqual([])
    expect(titles(store, "in:tool delta")).toEqual(["kinds"])
    const hit = search(store, "bravo", { now: NOW }).results[0]!.hits[0]!
    expect(hit).toMatchObject({ kind: "reasoning", seq: 1, message: "m2" })
  })
})

describe("matching", () => {
  async function corpus() {
    const store = new Store(":memory:")
    const source = fake()
    source.put("cjk", { title: "中文" }, [user("m1", "我们来整理一下需求，然后开始写代码")])
    source.put("code", { title: "code" }, [user("m1", "rename CommandPalette to dialog_select_file in utf8Decode")])
    source.put("typo", { title: "typo" }, [user("m1", "the middleware handles authentication")])
    source.put("words", { title: "words" }, [user("m1", "need to compact the history"), user("m2", "café crème")])
    await store.refresh([source.adapter])
    return store
  }

  test("CJK words match as exact substrings", async () => {
    const store = await corpus()
    expect(titles(store, "需求")).toEqual(["中文"])
    expect(titles(store, "整理需求")).toEqual([]) // not adjacent in the text
    expect(titles(store, "开始写")).toEqual(["中文"])
    const hit = search(store, "需求", { now: NOW }).results[0]!.hits[0]!
    expect(hit.text.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe("需求")
  })

  test("identifier parts, prefixes, typos, accents", async () => {
    const store = await corpus()
    expect(titles(store, "palette")).toEqual(["code"])
    expect(titles(store, "commandpalette")).toEqual(["code"])
    expect(titles(store, "select file")).toEqual(["code"])
    expect(titles(store, "decode")).toEqual(["code"])
    expect(titles(store, "midleware")).toEqual(["typo"])
    expect(titles(store, "authent")).toEqual(["typo"])
    expect(titles(store, "compaction")).toEqual([]) // longer than the word: not a prefix
    expect(titles(store, "cafe")).toEqual(["words"])
    expect(titles(store, '"midleware"')).toEqual([]) // quoted: exact
  })

  test("highlights are exactly what matched", async () => {
    const store = await corpus()
    const hit = search(store, "midleware authent", { now: NOW }).results[0]!.hits[0]!
    expect(hit.ranges.map((range) => [hit.text.slice(range.start, range.end), range.kind])).toEqual([
      ["middleware", "typo"],
      ["authent", "prefix"],
    ])
    const code = search(store, "palette", { now: NOW }).results[0]!.hits[0]!
    expect(code.ranges.map((range) => code.text.slice(range.start, range.end))).toEqual(["Palette"])
  })

  test("all words must match, in one part or across the session", async () => {
    const store = await corpus()
    expect(titles(store, "compact history")).toEqual(["words"])
    expect(titles(store, "compact crème")).toEqual(["words"])
    expect(search(store, "compact crème", { now: NOW }).results[0]!.spread).toBe(true)
    expect(titles(store, "compact needle")).toEqual([])
    expect(titles(store, "compact -crème")).toEqual([])
  })
})

describe("ranking", () => {
  test("exact before fuzzy, recent before old, archived last", async () => {
    const store = new Store(":memory:")
    const source = fake()
    const session = (opening: string, text: string) => [user("m0", opening), user("m1", text)]
    source.put("old", { title: "old exact", updated: NOW - 300 * DAY }, session("one", "deploy the gateway"))
    source.put("new", { title: "new exact", updated: NOW - DAY }, session("two", "deploy the gateway"))
    source.put("typo", { title: "typo", updated: NOW }, session("three", "deploy the gatewya"))
    source.put("archived", { title: "archived", updated: NOW, archived: NOW }, session("four", "deploy the gateway"))
    await store.refresh([source.adapter])
    // gatewya is one swap from gateway
    expect(titles(store, "gateway")).toEqual(["new exact", "archived", "old exact", "typo"])
    expect(titles(store, "-is:archived gateway")).toEqual(["new exact", "old exact", "typo"])
  })

  test("a fork's copy of a match folds into the original", async () => {
    const store = new Store(":memory:")
    const source = fake()
    const history = [user("m1", "the quarterly report numbers"), assistant("m2", [{ kind: "assistant", text: "done" }])]
    source.put("origin", { title: "origin", updated: NOW - DAY }, history)
    source.put("fork", { title: "fork", updated: NOW - 2 * DAY }, [...history.map((message) => ({ ...message, id: message.id + "f" })), user("m3", "other")])
    await store.refresh([source.adapter])
    const results = search(store, "quarterly", { now: NOW }).results
    expect(results.map((result) => result.session.title)).toEqual(["origin"])
    expect(results[0]!.copies?.map((copy) => copy.title)).toEqual(["fork"])
  })

  test("filters", async () => {
    const store = new Store(":memory:")
    const a = fake("alpha")
    const b = fake("beta")
    a.put("1", { title: "one", directory: "/work/backend", updated: NOW - DAY }, [user("m", "shared word")])
    b.put("2", { title: "two", directory: "/work/frontend", updated: NOW - 10 * DAY, parent: "1" }, [user("m", "shared word")])
    await store.refresh([a.adapter, b.adapter])
    expect(titles(store, "shared agent:alpha")).toEqual(["one"])
    expect(titles(store, "shared -agent:alpha")).toEqual(["two"])
    expect(titles(store, "shared dir:front")).toEqual(["two"])
    expect(titles(store, "shared date:<2d")).toEqual(["one"])
    expect(titles(store, "shared date:>1w")).toEqual(["two"])
    expect(titles(store, "shared is:child")).toEqual(["two"])
    expect(titles(store, "shared -is:child")).toEqual(["one"])
    expect(titles(store, "agent:beta")).toEqual(["two"])
  })
})

describe("read", () => {
  test("slices, kinds, long parts", async () => {
    const store = new Store(":memory:")
    const source = fake()
    const long = "x".repeat(5000) + " needle " + "y".repeat(5000)
    source.put("ses_abc", { title: "t" }, [
      user("m0", "zero"),
      assistant("m1", [
        { kind: "reasoning", text: "thinking" },
        { kind: "tool-call", tool: "read", callID: "c1", text: "path: /a" },
        { kind: "tool-result", tool: "read", callID: "c1", text: long },
      ]),
      user("m2", "two"),
      user("m3", "three"),
    ])
    await store.refresh([source.adapter])
    const all = read(store, "ses_a")!
    expect(all.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3])
    expect(all.messages[1]!.parts.map((part) => part.kind)).toEqual(["reasoning", "tool-call", "tool-result"])
    const result = all.messages[1]!.parts[2]!
    expect(result.omitted).toBe(long.length - 4000)
    expect(readPart(store, "fake:ses_abc", 1, 2)!.text).toBe(long)
    expect(read(store, "ses_abc", { from: -2 })!.messages.map((message) => message.seq)).toEqual([2, 3])
    expect(read(store, "ses_abc", { around: 2, context: 1 })!.messages.map((message) => message.seq)).toEqual([1, 2, 3])
    expect(read(store, "ses_abc", { kinds: new Set(["reasoning"]) })!.messages[1]!.parts.map((part) => part.text)).toEqual(["thinking"])
    expect(read(store, "nope")).toBeUndefined()
  })
})

describe("ids", () => {
  test("shortest unique prefixes, harness in front when an id is in two stores", async () => {
    const store = new Store(":memory:")
    const a = fake("one")
    const b = fake("two")
    a.put("ses_abcdef123", {}, [user("m", "x")])
    a.put("ses_abcdef999", {}, [user("m", "x")])
    a.put("zzzzzzzzzzzz", {}, [user("m", "x")])
    b.put("zzzzzzzzzzzz", {}, [user("m", "x")])
    await store.refresh([a.adapter, b.adapter])
    const short = shortIds(store)
    expect(short("one", "ses_abcdef123")).toBe("ses_abcdef1")
    expect(short("one", "zzzzzzzzzzzz")).toBe("one:zzzzzzzz")
    expect(read(store, "one:zzzzzzzz")?.session.harness).toBe("one")
  })

  test("caller", () => {
    expect(caller({ OPENCODE_SESSION_ID: "ses_1" })).toEqual({ session: "ses_1" })
    expect(caller({ AI_AGENT: "pi", PI_SESSION_ID: "p1" })).toEqual({ harness: "pi", session: "p1" })
    expect(caller({ CODEX_THREAD_ID: "t1" })).toEqual({ harness: "codex", session: "t1" })
    expect(caller({ CLAUDECODE: "1" })).toEqual({ harness: "claude", session: undefined })
    expect(caller({})).toEqual({})
  })
})
