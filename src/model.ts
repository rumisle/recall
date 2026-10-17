/** What a piece of a transcript is. Every kind is indexed and readable. */
export type Kind = "user" | "assistant" | "reasoning" | "tool-call" | "tool-result" | "system"

export const KINDS: readonly Kind[] = ["user", "assistant", "reasoning", "tool-call", "tool-result", "system"]

export interface Part {
  kind: Kind
  text: string
  /** Tool name, for tool-call and tool-result parts. */
  tool?: string
  /** The call this result answers (or the call's own id), to pair calls with results. */
  callID?: string
  /** For tool results: the call failed. */
  error?: true
}

export interface Message {
  /** Stable within the session. */
  id: string
  /** Epoch milliseconds. */
  time: number
  role: "user" | "assistant" | "system" | "tool"
  parts: Part[]
  /** Changes when the message changes. Without one the index compares content. */
  marker?: string
}

export interface SessionInfo {
  harness: string
  id: string
  title: string
  directory: string
  /** Epoch milliseconds. */
  created: number
  updated: number
  /** Parent session id (same harness), for subagent / worker sessions. */
  parent?: string
  /** Epoch milliseconds when archived. */
  archived?: number
  /** Model of the last assistant message, "provider/model". */
  model?: string
  /** Where it was read from (file or database). */
  source: string
}

/** A session as listed by an adapter, before reading its messages. */
export interface Listing {
  id: string
  /** Changes whenever the session's content may have changed. */
  marker: string
}

/** A message the adapter did not re-read because its marker is unchanged. */
export interface Unchanged {
  id: string
  unchanged: true
}

export interface Transcript {
  session: SessionInfo
  messages: (Message | Unchanged)[]
}

export interface Adapter {
  harness: string
  /** Every session, cheaply. Undefined when the store does not exist. */
  list(): Promise<Listing[] | undefined>
  /**
   * The session's messages, in order. `known` maps message ids already indexed to their markers; an adapter that
   * can tell a message is unchanged without parsing it may return it as Unchanged.
   */
  load(id: string, known: Map<string, string>): Promise<Transcript | undefined>
}
