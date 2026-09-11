# Session Observer

This fork adds read-only **Grok Build** and **Antigravity desktop / CLI** transcript sources. See [supported formats, setup, and limitations](docs/grok-antigravity.md). Upstream: [Ax-For/session-observer](https://github.com/Ax-For/session-observer).

It also adds a **collaboration dashboard and explicit local recorder** for parent/child tasks, dispatched briefs, returns, rework, independent acceptance, executor health snapshots, and concurrent write claims. See the [workflow and CLI guide](docs/collaboration.md). Only registered calls are tracked; the recorder is not a permission sandbox or an automatic interceptor of agent apps.

**A local-first session and collaboration workbench for Codex, Claude Code, Grok Build, and Antigravity.** Inspect recorded instructions, replies, tools, usage, and explicitly registered delegation workflows in one interface. Transcript viewing stays local; provider-specific coverage and missing fields are described below.

[![CI](https://github.com/wuchenchenyo/session-observer/actions/workflows/ci.yml/badge.svg)](https://github.com/wuchenchenyo/session-observer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-LTS%20or%20newer-339933.svg)](package.json)
[![React](https://img.shields.io/badge/react-19-149eca.svg)](package.json)
[![Local first](https://img.shields.io/badge/data-local--first-16a085.svg)](#privacy-model)

[中文文档](README.zh-CN.md)

![Session Observer overview](docs/screenshots/overview.png)

Session Observer is built for developers who use multiple local coding agents and need to answer practical questions quickly:

- What is running right now, and which session is still writing?
- What did the user ask, what did the agent answer, and which tools ran in between?
- Where did input, cache-read, cache-write, output, reasoning, and estimated cost come from?
- Which models, workspaces, files, and commands dominate usage?
- Can a large transcript history be inspected without building a memory-heavy global event index?
- Which agent received a delegated task, what did it return, and did the controller accept it or request rework?

## Start in 30 seconds

```bash
npm install
./manage.sh start
./manage.sh open
```

The default UI is [http://127.0.0.1:8787](http://127.0.0.1:8787). No account or external database is required.

`manage.sh` builds the Vite frontend when needed and runs the Node service with a constrained heap. For UI-only development, use `npm run dev`.

## Product surfaces

| Surface | What it is for |
| --- | --- |
| **Overview** | Runtime and source health, RSS and heap usage, today's sessions and conversations, 24-hour event and token load, active writers, usage cadence, and workspace concentration |
| **Token ledger** | Uncached input, cache hits, cache creation, output, reasoning output, estimated cost, efficiency ratios, forecasts, trends, model attribution, workspace attribution, and high-cost sessions |
| **Event stream** | Semantic activity grouped by user turn, dedicated Q&A/tool/usage/raw views, explicit search, filters, highlighted dialogue matches, live follow/pause, and direct jumps into session detail |
| **Session library** | Active sessions, workspace grouping, directory tree, stable full-session totals, start and latest timestamps, collapsible conversations, activity, usage, files/tools, commands, errors, compactions, and raw diagnostics |
| **Collaboration** | Explicit task hierarchy, dispatch/return/review timeline, linked sessions, health snapshots, and local concurrency/write-claim checks |

The session workbench also supports execution replay, deterministic two-session comparison, and local outcome annotations. Comparisons use compact summaries instead of loading complete transcripts.

## Multi-agent collaboration

Open **Collaboration / 协同** in the sidebar (shortcut **5**) to follow registered work across the four executors. The page refreshes every 10 seconds, supports manual refresh, and adapts to desktop and narrow screens.

| Capability | What is recorded or checked |
| --- | --- |
| Parent/child task tree | Explicit task and parent IDs, executor, work directory, declared write paths, and search/status filters |
| Dispatch details | Dispatched brief, command summary, timeout, requested model, and observed model metadata when available |
| Return and rework timeline | Result summaries, attempt numbers, reasons for rework, and failure categories such as auth, quota, permission, network, and timeout |
| Independent acceptance | A successful command enters `awaiting_review`; the controller records `passed` with evidence or requests rework |
| Session navigation | Opens explicitly linked Codex, Claude, Grok, or Antigravity sessions; no inferred links based on time or directory |
| Executor health snapshots | Latest recorded status, scope, reason, and check time; a command returning successfully does not prove provider availability |
| Concurrency and write claims | At most two external tasks running in one ledger; rejects overlapping declared write paths across running tasks, including Codex |
| Local recorder | Append-only JSONL with private directory/file permissions, bounded capture, common-secret redaction, and read-only collaboration HTTP endpoints |

```text
Codex creates a parent task and delegates a child
  → running → awaiting_review → passed (with independent evidence)
                              → rework → running (next attempt)
```

The parent cannot pass while unfinished children remain. Task tracking does not create an operating-system sandbox or grant permissions. Only calls registered in this ledger are tracked; existing transcripts are not automatically backfilled into a delegation tree. Health snapshots do not trigger background probes, and failures are not retried automatically.

### Recorder entrypoints

Run these from the repository root to inspect the recorder and existing tasks:

```bash
node server/collaboration-cli.js --help
node server/collaboration-cli.js list
```

The CLI provides `create`, `run`, `event`, `health`, `list`, and `show`. A `run` starts the explicitly specified executable without a shell and records its dispatch and return. The [complete example](docs/collaboration.md#最小工作流) covers task creation and independent acceptance using a synthetic local command without calling a provider.

For an approved brief and an existing parent task, the included Claude review adapter automatically registers a child and records its return:

```bash
python3 examples/claude-review.py \
  --brief /absolute/approved-brief.txt \
  --out /absolute/new-review.txt \
  --observer-parent EXISTING_PARENT_TASK_ID \
  --timeout 300
```

This explicitly invokes Claude and sends the brief through the installed CLI using an existing subscription login. Tools, Chrome, and session persistence are disabled; no API/provider fallback is enabled. The result remains pending controller acceptance. When no transcript is persisted, the dashboard retains the invocation record without inventing a session link.

Grok and Antigravity CLI calls can use the generic runner with an already verified entrypoint. GUI calls require explicit dispatch/return events; the observer does not automatically intercept agent applications. See the [workflow guide](docs/collaboration.md) for schemas, session IDs, directory setup, redaction limits, and recovery after recorder crashes.

## Why it is different

### Semantic activity instead of raw log noise

The default event stream groups a user turn, its agent response, tool calls, token snapshots, model, duration, and errors into one expandable activity. The raw view remains available for debugging, but internal records no longer overwhelm the normal workflow.

Search is submitted explicitly and matches only user and agent dialogue content. It does not produce noisy hits from internal metadata, paths, or token records.

### One canonical session workbench

Every event-to-session jump opens the same detail surface. Full-session counts and token totals come from the stable summary, while conversation content is read from a bounded recent window. The latest 400 raw events load first, turns are collapsible, and older content is fetched only when requested.

### Detailed token and cost attribution

Token accounting separates:

- uncached input;
- cache-read input;
- cache creation;
- model output;
- reasoning output.

The UI attributes usage by time window, model, platform, workspace, and session. Cost values are estimates based on the recognized model price table; they are not provider invoices.

The Token ledger exposes a confidence score with pricing coverage, session Token coverage, summary-cache reuse, unknown models, and the bundled price-table version. Optional daily and weekly Token/cost budgets provide local warnings.

### Replay, outcomes, and local review

Session detail combines conversation, execution replay, usage, and outcomes in one workbench. Replay highlights slow gaps, tool steps, failures, and Token snapshots. Outcome review stores completion status, tags, favorites, and notes in `~/.session-observer/session-annotations.json`; prompt and response text is not copied.

### Designed for large local histories

Session Observer avoids retaining the complete transcript corpus in memory:

- recent event pages are reverse-scanned directly from source files;
- completed archive summaries are reused when files do not change;
- growing current files are parsed incrementally;
- persistent summaries keep bounded goals, outcomes, tools, files, errors, compactions, and model transitions instead of raw event arrays;
- the UI virtualizes or batches large lists and exposes process RSS, heap, external memory, and cache state.

This keeps normal navigation responsive even when individual JSONL files are hundreds of megabytes. Actual memory usage still depends on transcript shape, active filters, and the number of pages explicitly loaded.

## Screenshots

Screenshots use sanitized example data. They do not contain real prompts, local user paths, tool output, credentials, or source JSONL records.

| Overview | Event stream |
| --- | --- |
| ![Overview dashboard](docs/screenshots/overview.png) | ![Event stream](docs/screenshots/stream.png) |

| Token ledger | Session workbench |
| --- | --- |
| ![Token dashboard](docs/screenshots/tokens.png) | ![Session detail](docs/screenshots/sessions.png) |

## Data sources

| Source | Default path | Data used |
| --- | --- | --- |
| Codex sessions | `~/.codex/sessions/**/*.jsonl` | Prompts, agent messages, tool calls, token usage, models, timestamps, and working directories |
| Claude Code projects | `~/.claude/projects/**/*.jsonl` | Project sessions, messages, tool activity, models, and usage |
| Grok Build | `~/.grok/sessions` | `chat_history.jsonl`, selected `events.jsonl` lifecycle records, and adjacent `summary.json` / `usage.json` metadata |
| Antigravity desktop | `~/.gemini/antigravity/brain` | Plaintext `*/.system_generated/logs/transcript.jsonl`; falls back to `transcript_full.jsonl` when absent |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain` | The same plaintext transcript format, with separate session IDs from desktop |
| Collaboration ledger | `~/.session-observer/collaboration/collaboration-ledger.jsonl` | Explicit task, dispatch, return, review, session-link, and health records written by the local recorder |
| Codex state DB | `~/.codex/state_5.sqlite` | Session title metadata, read through the `sqlite3` CLI |

Transcript changes are observed through filesystem notifications and streamed to the browser. Event pages and searches are read on demand; the collaboration page polls its separate local ledger.

Grok and Antigravity sources are read-only, with rename/delete disabled. Viewing them requires no API key or provider login. Grok usage is shown only when recorded values can be joined reliably. Antigravity requires the supported plaintext logs: `.db`/`.pb` stores are not decoded, and missing model or Token values remain unknown. These adapters cannot reconstruct every model request or hidden reasoning. See [source coverage and limitations](docs/grok-antigravity.md).

## Requirements

- Node.js LTS or newer
- npm
- `sqlite3` CLI for Codex title metadata
- A modern desktop browser
- Python 3 and an installed, authenticated Claude CLI only when using the optional Claude review adapter

## Commands

```bash
./manage.sh start      # Start the observer in the background
./manage.sh status     # Show PID and local URL
./manage.sh logs -f    # Follow runtime logs
./manage.sh stop       # Stop the service
./manage.sh run        # Run in the foreground

npm test               # Frontend Vitest suite
npm run test:core      # Parser, aggregation, cache, and route tests
npm run build          # Production frontend build
npm run check          # Lint, all tests, and production build
```

## Architecture

```text
server.js              Local HTTP API and built frontend
manage.sh              Service lifecycle and memory-oriented Node flags
server/                On-demand scanning, source watchers, summary cache, and routes
server/collaboration-cli.js    Explicit local task recorder and executable runner
server/collaboration-store.js  Task lifecycle, JSONL ledger, concurrency and write claims
examples/claude-review.py      Optional observed Claude subscription review entrypoint
shared/                Codex / Claude / Grok / Antigravity parsing and shared aggregation
src/app.jsx            React shell, URL state, and workspace orchestration
src/components/        Overview, token, event stream, sessions, collaboration, and details
src/hooks/             Data loading, source changes, paging, and session actions
src/lib/               Activity models, view models, formatting, paging, and URL helpers
tests/                 Node-side parser, cache, memory, route, and trace tests
```

The backend remains one local Node process. Vite builds the React interface, which is served by the same process. Shared parsing keeps server summaries and frontend views on the same event vocabulary.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `8787` | HTTP port |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex transcript directory |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code project directory |
| `GROK_SESSIONS_DIR` | `~/.grok/sessions` | Grok Build session directory |
| `ANTIGRAVITY_BRAIN_DIR` | `~/.gemini/antigravity/brain` | Antigravity desktop plaintext transcript root |
| `ANTIGRAVITY_CLI_BRAIN_DIR` | `~/.gemini/antigravity-cli/brain` | Antigravity CLI plaintext transcript root |
| `OBSERVER_DATA_DIR` | `~/.session-observer` | Local observer data directory |
| `OBSERVER_COLLABORATION_DIR` | `$OBSERVER_DATA_DIR/collaboration` | Dedicated ledger directory; use the same setting for CLI and server |
| `CODEX_STATE_DB` | `~/.codex/state_5.sqlite` | Codex title metadata database |
| `OBSERVER_DAILY_TOKEN_BUDGET` | disabled | Daily Token warning threshold |
| `OBSERVER_WEEKLY_TOKEN_BUDGET` | disabled | Seven-day Token warning threshold |
| `OBSERVER_DAILY_COST_BUDGET_USD` | disabled | Daily estimated-cost warning threshold |
| `OBSERVER_WEEKLY_COST_BUDGET_USD` | disabled | Seven-day estimated-cost warning threshold |
| `OBSERVER_MIN_CACHE_COVERAGE` | `70` | Minimum cache-read coverage percentage |
| `OBSERVER_DIALOGUE_SEARCH` | `scan` | Set to `sqlite` for optional disk-backed archive FTS |
| `OBSERVER_SOURCE_ADAPTERS_FILE` | disabled | JSON manifest for additional generic JSONL sources |

```bash
PORT=8790 CODEX_SESSIONS_DIR=/path/to/codex/sessions ./manage.sh start
```

Custom JSONL sources can be registered without changing the scanner:

```json
{
  "sources": [{
    "key": "local-agent",
    "label": "Local Agent",
    "directories": ["~/.local-agent/sessions"],
    "pathMarkers": ["/.local-agent/"],
    "parserKey": "parseGenericLineToEvent"
  }]
}
```

The generic parser recognizes common role, message, content, session, timestamp, model, working-directory, tool, and usage fields. With `OBSERVER_DIALOGUE_SEARCH=sqlite`, immutable pre-today dialogue is indexed on disk while today's growing files continue to use direct reverse scanning.

## Privacy model

Session transcripts may contain prompts, source code, tool output, filesystem paths, and credentials. Session Observer is designed for local inspection:

- the default server binds only to `127.0.0.1`;
- transcript JSONL files and `.runtime/` artifacts are excluded from source control;
- searches and dashboards run against local files;
- no telemetry or hosted storage is required.

Only bind to a non-local interface when you understand the exposure risk:

```bash
HOST=0.0.0.0 ./manage.sh start
```

## Project

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [MIT license](LICENSE)
- [Social preview](docs/social-preview.png)

## Roadmap

- Additional local coding-agent adapters.
- Session comparison and timeline diffing.
- More configurable pricing aliases and retention controls.
- Deeper diagnostics for long-running source watchers and cache reuse.
