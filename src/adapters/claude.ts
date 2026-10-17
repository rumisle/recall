import { basename, dirname, join } from "node:path"
import type { Adapter, Message, Part, SessionInfo } from "../model"
import { blockText, epoch, readLines, renderInput, walk } from "./shared"

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl, subagents in <project>/<session>/subagents/agent-*.jsonl.
// One line per event; an assistant reply is split across lines (one content block each) sharing message.id.

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

export function claude(root: string): Adapter {
  const files = new Map<string, string>()
  return {
    harness: "claude",
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
      let customTitle = ""
      let aiTitle = ""
      let firstUser = ""
      for (const line of lines) {
        if (line.cwd) cwd = line.cwd
        if (line.type === "custom-title" && line.customTitle) customTitle = line.customTitle
        if (line.type === "ai-title" && line.aiTitle) aiTitle = line.aiTitle
        if (line.type !== "user" && line.type !== "assistant") continue
        const time = epoch(line.timestamp)
        const content = line.message?.content
        if (line.type === "assistant") {
          const parts = (Array.isArray(content) ? content : [{ type: "text", text: content }]).flatMap((block: Json): Part[] => {
            if (block.type === "text" && block.text) return [{ kind: "assistant", text: block.text }]
            if (block.type === "thinking" && block.thinking) return [{ kind: "reasoning", text: block.thinking }]
            if (block.type === "tool_use") {
              tools.set(block.id, block.name)
              return [{ kind: "tool-call", tool: block.name, callID: block.id, text: renderInput(block.input) }]
            }
            return []
          })
          if (parts.length) messages.push({ id: line.uuid, time, role: "assistant", parts })
          continue
        }
        if (Array.isArray(content) && content.some((block: Json) => block.type === "tool_result")) {
          const parts = content
            .filter((block: Json) => block.type === "tool_result")
            .map(
              (block: Json): Part => ({
                kind: "tool-result",
                tool: tools.get(block.tool_use_id),
                callID: block.tool_use_id,
                text: blockText(block.content),
                ...(block.is_error ? { error: true as const } : {}),
              }),
            )
          messages.push({ id: line.uuid, time, role: "tool", parts })
          continue
        }
        const text = blockText(content)
        if (!text) continue
        const meta = line.isMeta || /^<(command|local-command|system-reminder)/.test(text)
        if (!meta && !firstUser) firstUser = text
        messages.push({ id: line.uuid, time, role: meta ? "system" : "user", parts: [{ kind: meta ? "system" : "user", text }] })
      }
      const subagent = basename(dirname(path)) === "subagents"
      const session: SessionInfo = {
        harness: "claude",
        id,
        title: oneLine(customTitle || aiTitle || firstUser),
        directory: cwd,
        created: messages[0]?.time ?? 0,
        updated: messages.at(-1)?.time ?? 0,
        parent: subagent ? basename(dirname(dirname(path))) : undefined,
        model: lines.findLast((line) => line.type === "assistant" && line.message?.model)?.message.model,
        source: path,
      }
      return { session, messages }
    },
  }
}

function sessionID(path: string) {
  return basename(path, ".jsonl")
}

export function oneLine(text: string, max = 120) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

export const claudeRoot = (home: string) => join(home, ".claude", "projects")
