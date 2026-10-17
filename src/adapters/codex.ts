import { basename } from "node:path"
import type { Adapter, Message, Part, SessionInfo } from "../model"
import { oneLine } from "./claude"
import { blockText, epoch, readLines, renderInput, walk } from "./shared"

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. The conversation is the `response_item` lines; `event_msg`
// lines repeat it for the UI and are skipped. Reasoning is encrypted; only its summary is readable.

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

const INJECTED = /^\s*<(environment_context|user_instructions|permissions instructions|user_shell_command|turn_aborted)|^# AGENTS\.md/

export function codex(root: string): Adapter {
  const files = new Map<string, string>()
  return {
    harness: "codex",
    async list() {
      const found = await walk(root, ".jsonl")
      if (!found) return undefined
      files.clear()
      return found.map((file) => {
        const id = sessionID(file.path)
        files.set(id, file.path)
        return { id, marker: `${file.mtime}:${file.size}` }
      })
    },
    async load(id) {
      const path = files.get(id)
      if (!path) return undefined
      const lines = readLines(await Bun.file(path).text()) as Json[]
      const tools = new Map<string, string>()
      const messages: Message[] = []
      let cwd = ""
      let model = ""
      let firstUser = ""
      let parent: string | undefined
      lines.forEach((line, index) => {
        const payload = line.payload ?? {}
        if (line.type === "session_meta") {
          cwd = payload.cwd ?? cwd
          parent = payload.source?.subagent?.thread_spawn?.parent_thread_id ?? parent
        }
        if (line.type === "turn_context") {
          cwd = payload.cwd ?? cwd
          model = payload.model ?? model
        }
        if (line.type !== "response_item") return
        const time = epoch(line.timestamp)
        const msgID = `L${index}`
        const push = (role: Message["role"], parts: Part[]) => {
          if (parts.some((part) => part.text)) messages.push({ id: msgID, time, role, parts })
        }
        switch (payload.type) {
          case "message": {
            const text = blockText(payload.content)
            if (payload.role === "assistant") return push("assistant", [{ kind: "assistant", text }])
            const injected = payload.role !== "user" || INJECTED.test(text)
            if (!injected && !firstUser) firstUser = text
            return push(injected ? "system" : "user", [{ kind: injected ? "system" : "user", text }])
          }
          case "reasoning": {
            const text = [blockText(payload.summary), blockText(payload.content)].filter(Boolean).join("\n")
            return push("assistant", [{ kind: "reasoning", text }])
          }
          case "function_call":
          case "custom_tool_call":
          case "local_shell_call": {
            const name = payload.name ?? payload.type
            const callID = payload.call_id ?? payload.id
            tools.set(callID, name)
            const input = payload.arguments ?? payload.input ?? payload.action
            return push("assistant", [{ kind: "tool-call", tool: name, callID, text: renderInput(parseMaybe(input)) }])
          }
          case "function_call_output":
          case "custom_tool_call_output":
          case "local_shell_call_output": {
            const output = payload.output
            const text = typeof output === "string" ? unwrapOutput(output) : blockText(output?.content ?? output)
            return push("tool", [{ kind: "tool-result", tool: tools.get(payload.call_id), callID: payload.call_id, text }])
          }
          case "web_search_call":
            return push("assistant", [{ kind: "tool-call", tool: "web_search", text: renderInput(payload.action) }])
        }
      })
      const session: SessionInfo = {
        harness: "codex",
        id,
        title: oneLine(firstUser),
        directory: cwd,
        created: messages[0]?.time ?? epoch(lines[0]?.timestamp),
        updated: messages.at(-1)?.time ?? 0,
        parent,
        model: model ? `openai/${model}` : undefined,
        source: path,
      }
      return { session, messages }
    },
  }
}

// rollout-2026-04-10T15-19-55-<uuid>.jsonl
function sessionID(path: string) {
  const name = basename(path, ".jsonl")
  return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0] ?? name
}

function parseMaybe(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// custom tool outputs are JSON {"output": "...", "metadata": {...}}.
function unwrapOutput(output: string) {
  if (!output.startsWith("{")) return output
  const parsed = parseMaybe(output) as Json
  return typeof parsed?.output === "string" ? parsed.output : output
}
