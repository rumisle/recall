import type { Adapter, Message, Part, SessionInfo } from "../model"
import { oneLine } from "./claude"
import { blockText, epoch, readLines, renderInput, walk } from "./shared"

// pi: ~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl. Entries form a tree (parentId) when the user branches; every
// branch is indexed, in file order.

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

export function pi(root: string): Adapter {
  const files = new Map<string, string>()
  return {
    harness: "pi",
    async list() {
      const found = await walk(root, ".jsonl")
      if (!found) return undefined
      files.clear()
      const sessions = found.flatMap((file) => {
        const id = file.path.match(/_([^_/]+)\.jsonl$/)?.[1]
        if (!id) return []
        files.set(id, file.path)
        return [{ id, marker: `${file.mtime}:${file.size}` }]
      })
      return { sessions }
    },
    async load(id) {
      const path = files.get(id)
      if (!path) return undefined
      const lines = readLines(await Bun.file(path).text()) as Json[]
      const header = lines.find((line) => line.type === "session") ?? {}
      const messages: Message[] = []
      let name = ""
      let firstUser = ""
      let model = ""
      lines.forEach((line, index) => {
        const time = epoch(line.timestamp)
        const msgID = line.id ?? `L${index}`
        if (line.type === "session_info" && line.name) name = line.name
        if (line.type === "model_change") model = `${line.provider}/${line.modelId}`
        if (line.type === "compaction" && line.summary)
          messages.push({ id: msgID, time, role: "system", parts: [{ kind: "system", text: `[compaction summary]\n${line.summary}` }] })
        if (line.type === "branch_summary" && line.summary)
          messages.push({ id: msgID, time, role: "system", parts: [{ kind: "system", text: `[branch summary]\n${line.summary}` }] })
        if (line.type === "custom_message" && line.display !== false) {
          const text = blockText(line.content)
          if (text) messages.push({ id: msgID, time, role: "system", parts: [{ kind: "system", text: `[${line.customType}]\n${text}` }] })
        }
        if (line.type !== "message") return
        const message = line.message ?? {}
        const parts = toParts(message)
        if (!parts.length) return
        if (message.role === "user" && !firstUser) firstUser = parts[0]!.text
        const role = message.role === "toolResult" ? "tool" : message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system"
        messages.push({ id: msgID, time, role, parts })
      })
      const session: SessionInfo = {
        harness: "pi",
        id,
        title: oneLine(name || firstUser),
        directory: header.cwd ?? "",
        created: epoch(header.timestamp),
        updated: messages.at(-1)?.time ?? epoch(header.timestamp),
        model: model || undefined,
        source: path,
      }
      return { session, messages }
    },
  }
}

function toParts(message: Json): Part[] {
  if (message.role === "toolResult") {
    return [
      {
        kind: "tool-result",
        tool: message.toolName,
        callID: message.toolCallId,
        text: blockText(message.content),
        ...(message.isError ? { error: true as const } : {}),
      },
    ]
  }
  if (message.role === "user") {
    const text = blockText(message.content)
    return text ? [{ kind: "user", text }] : []
  }
  if (message.role !== "assistant") {
    const text = blockText(message.content)
    return text ? [{ kind: "system", text }] : []
  }
  const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]
  return content.flatMap((block: Json): Part[] => {
    if (block.type === "text" && block.text) return [{ kind: "assistant", text: block.text }]
    if (block.type === "thinking" && block.thinking) return [{ kind: "reasoning", text: block.thinking }]
    if (block.type === "toolCall") return [{ kind: "tool-call", tool: block.name, callID: block.id, text: renderInput(block.arguments) }]
    return []
  })
}
