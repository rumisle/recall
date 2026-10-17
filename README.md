# recall

Full-text search and transcript reading over past coding-agent sessions: ocelot / OpenCode 2, Claude Code, Codex
and pi. Every part of every message is indexed (prompts, replies, reasoning, tool calls and tool results), so a
search can land on the exact message, and a transcript can be read back in full.

Two consumers:

- **Agents** (any harness): `recall` CLI, `--json` for tools. Search past sessions, then read them, including the
  agent's own session after compaction.
- **ocelot's web app**: the library (`import { Store, search } from "recall"`) behind Cmd+K, ocelot sessions only.

## Requirements

Search (shared):
- Indexes titles, directories, user, assistant, reasoning, tool calls (input) and tool results; a hit names the
  session, message and part.
- Forgiving like fast-resume: prefixes and one-typo variants match, recent sessions rank higher, filter syntax
  `agent:` `dir:` `date:`. Strict about accuracy: exact matches rank above prefix/typo matches, and a highlight is
  exactly what matched (same tokenizer and rules for both).
- CJK, code, paths and identifiers all searchable (`需求`, `CommandPalette` by `palette`, `foo_bar` by `bar`).
- Archived sessions included but ranked lower; subagent / worker sessions included; both filterable.
- Fast: every keystroke; new messages searchable right away (a refresh before each search takes milliseconds).

Agent tool:
- Every harness, every directory, archived and child sessions; filters narrow it down.
- Read any transcript in full: message ranges, around a hit, by kind; long parts cut with a way to read them whole.

Web (ocelot integration, not here): Cmd+K searches content, not files; results grouped by session with highlighted
excerpts; opening one jumps to the matching message.

## Usage

```bash
recall "cache miss in:reasoning date:<2w"     # search (refreshes the index first)
recall read ses_4f2a91 --around 81 --context 3
recall read ses_4f2a91 --from -10 --in user,assistant
recall read ses_4f2a91 --part 81.2             # one part, whole
recall read self --from -20                   # the calling agent's own session
recall refresh
recall --help
```

Sessions are printed by their shortest unique id prefix (8+ characters; `harness:` in front when the same id is in
two stores); `read` and `session:` take any unique prefix.

Run from inside an agent, recall finds the agent's harness and session from the variables each harness sets for its
commands (`OPENCODE_SESSION_ID`, `PI_SESSION_ID`, `CODEX_THREAD_ID`, `CLAUDECODE`). Searches then cover only that
harness unless the query names `agent:` or `--all` is given, and `self` / `session:self` mean its own session.

Query syntax:

| | |
|---|---|
| `words` | all must appear; words of 3+ letters also match as prefixes, and rare words with one typo |
| `"exact phrase"` | in order, no prefixes or typos |
| `-word` | leave out sessions containing it |
| `agent:claude,codex` `-agent:pi` `agent:!pi` | harness: `ocelot` `opencode` `claude` `codex` `pi` |
| `dir:backend,!test` | directory contains (case-insensitive) |
| `date:<2d` `date:>1w` `today` `yesterday` `week` `month` | last activity; units `m h d w mo y` |
| `in:user,reasoning` `-in:tool` | parts: `user assistant reasoning tool call result system title` |
| `is:archived` `-is:child` | archived / subagent sessions only, or none |
| `session:ID` | within one session (id prefix) |

## How it works

- **Adapters** (`src/adapters`) read each store into one model (session, messages, parts). OpenCode-family databases
  (`opencode*.db`, ocelot's is `opencode-ocelot.db`) are read with SQLite, read-only; the rest are JSONL files.
- **Index** (`src/store.ts`): one SQLite file at `~/.cache/recall/index.db`. One row per part in `entry` (text
  zstd-compressed when long) and one FTS5 document per part (plus one per session title). The rowid encodes session
  and kind, so search groups and filters on the FTS table alone. Refresh compares cheap per-session markers (mtime and
  size; for OpenCode, update times), and per-message markers or content hashes, so only changed messages are
  rewritten. Concurrent refreshers (the server and CLI calls) re-check inside an IMMEDIATE transaction.
- **Tokenizer** (`src/tokenize.ts`): letters/digits runs, lowercased, accents removed; each CJK character a token (a
  CJK word is a phrase, i.e. an exact substring); identifiers also yield their parts. Text is tokenized in JS and
  FTS5 only splits on spaces, so the index, query and highlighter agree exactly.
- **Search** (`src/search.ts`): per term an FTS5 expression of the exact phrase, a prefix (unless the word itself is
  common) and typo variants (only for rare words: index words one edit or swap away, most frequent first). Strict
  tiers: every term exactly in one part; in one part with prefixes/typos; spread over parts. Within a tier: bm25 of the
  best part (skipped above 20k matching parts, where it dominates the cost) and number of matching parts, times
  fast-resume's recency curve (x2.5 today, x1.75 at two weeks), halved when archived. The grouping pass also collects
  which parts to show, so hits never re-run the match. Forks (same opening, same hit at the same position) fold into
  the better-ranked session as `copies`.

On a history of 1.7k sessions (540M characters): cold build 46 s, index 630 MB;
no-op refresh ~20 ms; searches 3–20 ms, ~35 ms for words in 100k+ parts; a CLI call end to end 50–90 ms.

## Development

```bash
bun test
bunx tsc --noEmit -p .
```
