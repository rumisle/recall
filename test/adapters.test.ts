import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claude } from "../src/adapters/claude"
import { codex } from "../src/adapters/codex"
import { opencode } from "../src/adapters/opencode"
import { pi } from "../src/adapters/pi"
import type { Adapter, Message, Unchanged } from "../src/model"

const temp = () => mkdtempSync(join(tmpdir(), "recall-"))
const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n"

async function loadOnly(adapter: Adapter) {
  const listing = await adapter.list()
  expect(listing).toHaveLength(1)
  const transcript = await adapter.load(listing![0]!.id, new Map())
  return transcript!
}

const summary = (messages: (Message | Unchanged)[]) =>
  messages.flatMap((message) => ("unchanged" in message ? [] : message.parts.map((part) => `${part.kind}${part.tool ? `(${part.tool})` : ""}: ${part.text}`)))

describe("adapters", () => {
  test("claude", async () => {
    const root = temp()
    mkdirSync(join(root, "-work-x"), { recursive: true })
    const at = "2026-10-01T10:00:00.000Z"
    await Bun.write(
      join(root, "-work-x", "s1.jsonl"),
      jsonl([
        { type: "user", uuid: "u1", cwd: "/work/x", timestamp: at, message: { role: "user", content: "fix the build" } },
        { type: "assistant", uuid: "a1", timestamp: at, message: { model: "claude-x", content: [{ type: "thinking", thinking: "look first" }] } },
        { type: "assistant", uuid: "a2", timestamp: at, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] } },
        { type: "user", uuid: "u2", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } },
        { type: "user", uuid: "u3", timestamp: at, isMeta: true, message: { content: "<system-reminder>x</system-reminder>" } },
        { type: "assistant", uuid: "a3", timestamp: at, message: { content: [{ type: "text", text: "fixed" }] } },
        { type: "custom-title", customTitle: "Build fix" },
      ]),
    )
    const transcript = await loadOnly(claude(root))
    expect(transcript.session).toMatchObject({ harness: "claude", id: "s1", title: "Build fix", directory: "/work/x", model: "claude-x" })
    expect(summary(transcript.messages)).toEqual([
      "user: fix the build",
      "reasoning: look first",
      "tool-call(Bash): command: make",
      "tool-result(Bash): ok",
      "system: <system-reminder>x</system-reminder>",
      "assistant: fixed",
    ])
  })

  test("codex", async () => {
    const root = temp()
    mkdirSync(join(root, "2026", "10", "01"), { recursive: true })
    const at = "2026-10-01T10:00:00.000Z"
    await Bun.write(
      join(root, "2026", "10", "01", "rollout-2026-10-01T10-00-00-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"),
      jsonl([
        { timestamp: at, type: "session_meta", payload: { id: "x", cwd: "/work/y" } },
        { timestamp: at, type: "turn_context", payload: { cwd: "/work/y", model: "gpt-x" } },
        { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>e</environment_context>" }] } },
        { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run the tests" }] } },
        { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "run the tests" } },
        { timestamp: at, type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "zzz" } },
        { timestamp: at, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"bun test"}' } },
        { timestamp: at, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "3 pass" } },
        { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "all pass" }] } },
      ]),
    )
    const transcript = await loadOnly(codex(root))
    expect(transcript.session).toMatchObject({ harness: "codex", id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", title: "run the tests", directory: "/work/y" })
    expect(summary(transcript.messages)).toEqual([
      "system: <environment_context>e</environment_context>",
      "user: run the tests",
      "reasoning: plan",
      "tool-call(exec_command): cmd: bun test",
      "tool-result(exec_command): 3 pass",
      "assistant: all pass",
    ])
  })

  test("pi", async () => {
    const root = temp()
    mkdirSync(join(root, "--work-z--"), { recursive: true })
    const at = "2026-10-01T10:00:00.000Z"
    await Bun.write(
      join(root, "--work-z--", "2026-10-01T10-00-00-000Z_abc-123.jsonl"),
      jsonl([
        { type: "session", id: "abc-123", timestamp: at, cwd: "/work/z" },
        { type: "message", id: "m1", timestamp: at, message: { role: "user", content: [{ type: "text", text: "hello" }] } },
        {
          type: "message",
          id: "m2",
          timestamp: at,
          message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] },
        },
        { type: "message", id: "m3", timestamp: at, message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } },
        { type: "compaction", id: "c1", timestamp: at, summary: "## Goal" },
        { type: "session_info", id: "i1", name: "named" },
      ]),
    )
    const transcript = await loadOnly(pi(root))
    expect(transcript.session).toMatchObject({ harness: "pi", id: "abc-123", title: "named", directory: "/work/z" })
    expect(summary(transcript.messages)).toEqual([
      "user: hello",
      "reasoning: hmm",
      "tool-call(bash): command: ls",
      "tool-result(bash): a.txt",
      "system: [compaction summary]\n## Goal",
    ])
  })

  test("opencode: re-reads only changed messages", async () => {
    const path = join(temp(), "opencode.db")
    const db = new Database(path)
    db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, model TEXT)`)
    db.run(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER,
      time_updated INTEGER, data TEXT)`)
    db.run(`INSERT INTO session_v2 VALUES ('ses_1', 'ses_0', '/work/o', 'Title', 1, 2, NULL, '{"id":"m","providerID":"p"}')`)
    const insert = db.query("INSERT INTO session_message VALUES (?, 'ses_1', ?, ?, 1, ?, ?)")
    insert.run("msg_1", "user", 0, 10, JSON.stringify({ text: "question", time: { created: 1 } }))
    insert.run(
      "msg_2",
      "assistant",
      1,
      10,
      JSON.stringify({
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "answer" },
          { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "out" }] } },
          { type: "tool", id: "t2", name: "read", state: { status: "error", input: { path: "/x" }, error: { message: "missing" } } },
        ],
      }),
    )
    const adapter = opencode("ocelot", path)
    const transcript = await loadOnly(adapter)
    expect(transcript.session).toMatchObject({ harness: "ocelot", id: "ses_1", parent: "ses_0", title: "Title", model: "p/m" })
    expect(summary(transcript.messages)).toEqual([
      "user: question",
      "reasoning: think",
      "assistant: answer",
      "tool-call(shell): command: ls",
      "tool-result(shell): out",
      "tool-call(read): path: /x",
      "tool-result(read): missing",
    ])
    const again = await adapter.load("ses_1", new Map([["msg_1", "10"], ["msg_2", "9"]]))
    expect(again!.messages.map((message) => ("unchanged" in message ? "unchanged" : message.id))).toEqual(["unchanged", "msg_2"])
  })
})
