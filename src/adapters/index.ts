import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Adapter } from "../model"
import { claude } from "./claude"
import { codex } from "./codex"
import { opencode } from "./opencode"
import { pi } from "./pi"

/** Every store found in the usual places. */
export function defaultAdapters(home = homedir()): Adapter[] {
  const data = process.env.XDG_DATA_HOME || join(home, ".local", "share")
  return [...opencodeStores(join(data, "opencode")), claude(join(home, ".claude", "projects")), codex(join(home, ".codex", "sessions")), pi(piRoot(home))]
}

// opencode.db is stock OpenCode; opencode-<channel>.db is another channel (ocelot's is opencode-ocelot.db).
function opencodeStores(dir: string): Adapter[] {
  const names = (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()
  return names.flatMap((name) => {
    const match = name.match(/^opencode(?:-([\w.-]+))?\.db$/)
    if (!match) return []
    return [opencode(match[1] ?? "opencode", join(dir, name))]
  })
}

function piRoot(home: string) {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR
  const agent = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent")
  return join(agent, "sessions")
}
