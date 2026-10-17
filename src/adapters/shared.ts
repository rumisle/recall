import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Tool input as readable text: one `key: value` line per field, multi-line strings verbatim under their key. JSON
 * would escape newlines ("\nfoo"), which reads badly and tokenizes into junk.
 */
export function renderInput(input: unknown): string {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return input
  if (typeof input !== "object" || Array.isArray(input)) return JSON.stringify(input)
  return Object.entries(input)
    .map(([key, value]) => {
      if (typeof value === "string") return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`
      return `${key}: ${JSON.stringify(value)}`
    })
    .join("\n")
}

/** Text of a content field that is a string or an array of blocks (Anthropic / OpenAI style). */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (typeof block?.text === "string") return block.text
      if (block?.type === "image" || block?.type === "input_image") return "[image]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function epoch(value: unknown): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/** Files under `dir` (recursively) ending in `suffix`, with their mtime and size. */
export async function walk(dir: string, suffix: string): Promise<{ path: string; mtime: number; size: number }[] | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => undefined)
  if (!entries) return undefined
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name)
      const info = await stat(path)
      return { path, mtime: info.mtimeMs, size: info.size }
    }),
  )
}

export function readLines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}
