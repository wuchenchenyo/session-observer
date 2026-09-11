# Grok Build and Antigravity sources

This fork reads existing local transcripts. It does not send requests to the
providers, install plugins into them, or alter their configuration or histories.
Run the existing `npm ci` and `./manage.sh start` workflow, then select **Grok Build**
or **Antigravity** in the event stream or session library platform filter.

## Discovery

| Provider | Default directory | Override |
| --- | --- | --- |
| Grok Build | `~/.grok/sessions` | `GROK_SESSIONS_DIR` |
| Antigravity desktop | `~/.gemini/antigravity/brain` | `ANTIGRAVITY_BRAIN_DIR` |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain` | `ANTIGRAVITY_CLI_BRAIN_DIR` |

Grok reads `chat_history.jsonl` and selected lifecycle events from `events.jsonl`
in each session directory. It reads adjacent `summary.json` and `usage.json` for
identity, title, workspace, model and recorded usage. Other logs and configuration
files are not ingested. Sidecar changes invalidate cached summaries.

Antigravity reads `*/.system_generated/logs/transcript.jsonl`, falling back to
`transcript_full.jsonl` only when the normal transcript is absent. Reading both
would duplicate the conversation. Numbered logs, `.db` and `.pb` stores are ignored.
Installations without plaintext transcripts therefore have no readable sessions;
the adapter does not decrypt opaque stores or contact private daemon APIs.

Missing source directories are harmless. No API keys or provider login are needed.
The new sources expose no rename/delete capabilities and reject those operations.
Their internal identifiers are namespaced to avoid collisions between providers
and between Antigravity desktop and CLI.

## What is recorded

| Feature | Grok Build | Antigravity |
| --- | --- | --- |
| User instructions and replies | Yes | `USER_INPUT` / `PLANNER_RESPONSE` |
| Tool calls and results | Chat tool calls/results; completion metadata when available | Explicit structured tool records; unknown step formats remain raw |
| Models | Recorded model IDs and session metadata | Only when present; otherwise unknown |
| Token usage | Recorded per-turn ledger when it can be joined unambiguously | Not provided by the observed plaintext schema |
| Event time | Recorded timestamps, or explicitly marked session-time fallback | Recorded `created_at` |
| Encrypted reasoning | Never displayed | Never decoded |

The observed Grok 1.0.x lifecycle numbers turns from zero, while its usage ledger
numbers them from one. A usage join requires that identity match and a unique
ledger end timestamp within one second after the recorded lifecycle end. Missing,
ambiguous, malformed or incompatible records are not counted as zero usage.
`inputTokens` already includes cached input; it is not added again. No conversion
of undocumented `costUsdTicks` units or invented Grok model prices is performed.
The existing UI's cost estimates/coverage are not provider invoices.

Grok chat records commonly lack individual timestamps. Their original file order
is retained using a shared session timestamp, labelled in event details. A known
tool completion time/duration is shown as additional metadata, not used to move a
tool result after the final reply. Precise chat latency cannot be reconstructed.

Antigravity's `step_index` identifies a step, not a user turn. Unknown step formats
remain raw records; the adapter does not infer tool calls from natural-language
text. System checkpoint summaries are excluded from dialogue. The actual observed
desktop sample covers input, planner reply and checkpoint; additional structured
tool variants have synthetic regression coverage and need validation with the
respective client version.

These are session viewers, not a complete reconstruction of every model request.
Cross-product delegation (for example Codex launching Grok through a shell) does
not automatically become a verified parent/child relationship. That requires a
shared identifier emitted by the launcher. The new adapters do not guess such links.

## Privacy and validation

Like the original observer, the UI can display sensitive text already present in
local logs, and its local cache may retain summaries. Keep the default loopback
binding. Do not publish real transcripts, caches or screenshots of private data.
The checked-in tests contain synthetic data only.

`npm run check` covers existing providers plus new parser and integration tests:
canonical discovery, namespaced IDs, reverse reads, detail hydration, sidecar-only
refresh, missing usage, duplicate avoidance, and rejected source mutations.

## Verification on 2026-09-11

- `npm run check`: strict lint, 104 frontend tests, 138 core tests, and the
  production build passed.
- A local read-only smoke test parsed 13 Grok sessions with 3 recorded usage
  events and one Antigravity desktop session. Codex and Claude sample histories
  also parsed successfully. Source-file modification times were unchanged; no
  private transcript content was copied into this repository.
- Chrome desktop verification used synthetic data only: platform filters,
  event JSON details, session navigation, one correctly ordered Grok user turn
  with tool activity and reply, Antigravity dialogue and unknown usage, disabled
  rename/delete actions, and canonical source counts (Grok 2 + Antigravity 1).
- At 390 × 844, records loaded and the platform selector was usable, but the
  session library showed horizontal overflow. Narrow-screen layout is a known
  limitation; this provider change does not claim full mobile acceptance.
- Internal review covered parsing, usage validation, sensitive structured
  fields, cache invalidation, read-only protections, and UI source labels.

The verification server used temporary synthetic source directories and was
stopped afterward. No background service is installed by this change.

本 fork 支持在同一页面查看 Grok 与 Antigravity 的会话、指令、回复及已记录的工具步骤。
缺失的模型、Token 或逐条时间不能还原；Grok 会话时间回退会明确标记。
Antigravity 必须有上述明文日志。原始记录始终只读，桌面版与 CLI 不会合并成同一会话。
