# recall

Search and read your past coding-agent sessions: OpenCode (and ocelot), Claude Code, Codex and pi, from one CLI.

Everything is indexed: prompts, replies, reasoning, tool calls and tool output. A search lands on the exact message,
and the transcript around it can be read back in full. Made for agents first ("what did we decide about X last
week?", or recovering details after a context compaction), and pleasant enough for people.

```
$ recall "cache miss in:reasoning"
4 sessions · 12 ms

1. Prompt cache warmer
   ses_4f2a91 · opencode · ~/work/proxy · 2d ago · 214 messages
   #57 thinking  …the 7-minute idle gap explains the «cache» «miss»: the TTL is 5 minutes, so…
   #61 assistant  Every «cache» «miss» after an idle gap now logs the gap and the tokens it cost.

2. ...

$ recall read ses_4f2a91 --around 57 --context 1
▌assistant #56 · 14:02
▶ shell $ grep -c cache_read logs/requests.jsonl
✓ 118

▌assistant #57 · 14:03
┆ the 7-minute idle gap explains the cache miss: the TTL is 5 minutes, so…
```

## Install

Needs [Bun](https://bun.sh) (prebuilt binaries are planned).

```bash
git clone https://github.com/rumisle/recall && cd recall && bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/recall
recall refresh    # first index: about a minute for a large history; afterwards it keeps itself current
```

For agents, add a skill or instruction telling them recall exists, e.g. "Use `recall` to search and read past
sessions: search first, then `recall read <id> --around <#>`; run `recall --help` for the syntax."

## Usage

```bash
recall "auth middleware"                  # sessions, best match first, with highlighted excerpts
recall "in:title quarterly report"        # by title
recall read ses_4f2a91 --around 81        # messages around a hit (#81)
recall read ses_4f2a91 --from -20         # the last 20 messages
recall read ses_4f2a91 --in user,assistant
recall read ses_4f2a91 --part 81.2        # one part in full (long parts are cut, and say so)
recall read self --from -30               # the calling agent's own session
```

Every command takes `--json`. Sessions are shown by their shortest unique id prefix; `read` takes any unique
prefix.

**Inside an agent**, recall detects which harness and session it runs in (from `OPENCODE_SESSION_ID`,
`PI_SESSION_ID`, `CODEX_THREAD_ID`, `CLAUDECODE`). It then searches only that harness unless the query has `agent:` or
`--all` is given, and `self` means the agent's own session.

### Query syntax

| | |
|---|---|
| `words` | all must appear; words of 3+ letters also match as prefixes, rare words with one typo |
| `"exact phrase"` | in order, nothing fuzzy |
| `-word` | leave out sessions containing it |
| `agent:claude,codex` `-agent:pi` | harness: `opencode` `ocelot` `claude` `codex` `pi` |
| `dir:backend,!test` | working directory contains |
| `date:<2d` `date:>1w` `today` `yesterday` `week` `month` | last activity; units `m h d w mo y` |
| `in:user,reasoning` `-in:tool` | `user assistant reasoning tool call result system title` |
| `is:archived` `-is:child` | archived / subagent sessions only, or none |
| `session:ID` | within one session |

Exact matches always rank above prefix and typo matches; among those, recent sessions rank higher. Highlights show
exactly what matched. Chinese, Japanese and Korean text matches as exact substrings; identifiers match by their
parts (`palette` finds `CommandPalette`).

## Where it reads from

| Harness | Location |
|---|---|
| OpenCode 2 | `~/.local/share/opencode/opencode*.db` (each channel's database, e.g. `opencode-ocelot.db` as `ocelot`) |
| Claude Code | `~/.claude/projects/**/*.jsonl`, including subagents |
| Codex | `~/.codex/sessions/**/*.jsonl` (reasoning is encrypted; only its summaries are readable) |
| pi | `~/.pi/agent/sessions/**/*.jsonl` (or `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`) |

All stores are read-only. The index is a local SQLite file, `~/.cache/recall/index.db` (`RECALL_DB` to move it); it
holds a copy of your transcripts, so treat it like them. Nothing leaves the machine.

## How it works

- **Index**: SQLite FTS5, one document per part of a message. Before each command, recall compares cheap change
  markers (file size and time, database update times) and re-reads only changed messages, which takes milliseconds.
- **Tokenizer**: one tokenizer for indexing, querying and highlighting, so they always agree. Each CJK character is a
  token (a CJK word is an exact phrase); identifiers also yield their parts.
- **Ranking**: three strict tiers (all words exactly in one part; with prefixes or typos; spread over several parts),
  then bm25 and the number of matches, times a recency boost (x2.5 today, x1.75 at two weeks), lower for archived
  sessions. Forked sessions that share a match are folded into one result.

On a history of 1.7k sessions (540M characters): first index 46 s and 630 MB; searches 3–35 ms; a CLI call, index
check included, 50–90 ms.

Inspired by [fast-resume](https://github.com/angristan/fast-resume).

## Development

```bash
bun test
bunx tsc --noEmit -p .
```
