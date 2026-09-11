const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("../server/config");
const { listSourceFileRecords, statFile } = require("../server/source-files");
const { providerContext } = require("../server/provider-context");
const { queryRecentEvents } = require("../server/recent-events-reader");
const { createSummaryStore } = require("../server/summary-store");
const { parseEventLineFromIndex } = require("../server/index-manager");
const core = require("../shared/observer-core");
const { parseGrokLineToEvent } = require("../shared/grok-event-parser");
const { parseAntigravityLineToEvent } = require("../shared/antigravity-event-parser");
const sessionOps = require("../server/session-ops");
const parsers = { ...core, parseGrokLineToEvent, parseAntigravityLineToEvent };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-providers-"));
  const keys = ["SESSIONS_DIR", "CLAUDE_PROJECTS_DIR", "GROK_SESSIONS_DIR", "ANTIGRAVITY_BRAIN_DIR", "ANTIGRAVITY_CLI_BRAIN_DIR"];
  const original = Object.fromEntries(keys.map((key) => [key, config[key]]));
  for (const key of keys) config[key] = path.join(root, key);
  t.after(() => { Object.assign(config, original); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, value, jsonl = true) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl ? `${value.map((row) => JSON.stringify(row)).join("\n")}\n` : JSON.stringify(value));
  };
  const grokDir = path.join(config.GROK_SESSIONS_DIR, "project", "synthetic-session");
  const chat = path.join(grokDir, "chat_history.jsonl");
  const events = path.join(grokDir, "events.jsonl");
  const usage = path.join(grokDir, "usage.json");
  const end = "2026-09-11T01:00:04.000Z";
  write(path.join(grokDir, "summary.json"), { info: { id: "synthetic-session", cwd: "/synthetic/project" }, session_summary: "Grok demo", current_model_id: "grok-4.6", created_at: "2026-09-11T01:00:00.000Z" }, false);
  write(chat, [
    { type: "system", content: "Synthetic instructions" },
    { type: "user", content: [{ type: "text", text: "List sample files" }] },
    { type: "assistant", content: "", tool_calls: [{ id: "call-1", name: "list_files", arguments: "{\"path\":\"/synthetic\"}" }] },
    { type: "tool_result", tool_call_id: "call-1", content: "sample.txt" },
    { type: "assistant", content: "Found sample.txt" },
  ]);
  write(events, [
    { type: "turn_started", session_id: "synthetic-session", turn_number: 0, ts: "2026-09-11T01:00:00.000Z" },
    { type: "tool_completed", tool_call_id: "call-1", tool_name: "list_files", duration_ms: 42, outcome: "success", ts: "2026-09-11T01:00:02.000Z" },
    { type: "turn_ended", ts: end, outcome: "completed" },
  ]);
  const ledger = { turns: [{ turnNumber: 1, endedAt: "2026-09-11T01:00:04.018000+00:00", inputTokens: 100, cachedReadTokens: 60, cacheCreationTokens: 0, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, primaryModelId: "grok-4.6-build" }] };
  write(usage, ledger, false);
  write(path.join(grokDir, "updates.jsonl"), [{ type: "user", content: "MUST NOT BE DISCOVERED" }]);
  const ag = path.join(config.ANTIGRAVITY_BRAIN_DIR, "synthetic-session", ".system_generated", "logs", "transcript.jsonl");
  const agRows = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-09-11T02:00:00Z", content: "<USER_REQUEST>Explain the sample</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-11T02:00:02Z", content: "This is a synthetic sample." },
  ];
  write(ag, agRows);
  write(ag.replace("transcript.jsonl", "transcript_full.jsonl"), agRows);
  return { root, chat, events, usage, ledger, ag, write };
}

test("providers discover canonical transcripts once and keep identity across files and detail reads", (t) => {
  const f = fixture(t);
  const records = listSourceFileRecords();
  assert.deepEqual(new Set(records.map((r) => r.file)), new Set([f.chat, f.events, f.ag]));
  const result = queryRecentEvents({ files: records, parsers, filters: { platform: "grok", order: "asc" }, limit: 100 });
  assert.equal(result.events.filter((e) => e.callType === "Tool_Call").length, 1);
  assert.equal(result.events.filter((e) => e.callType === "Token_Usage").length, 1);
  assert.deepEqual(new Set(result.events.map((e) => e.sessionId)), new Set(["grok:synthetic-session"]));
  const returned = result.events.find((e) => e.callType === "Tool_Result");
  assert.equal(returned.toolName, "list_files");
  assert.equal(returned.durationMs, 42);
  assert.equal(returned.timeSource, "session");
  const full = parseEventLineFromIndex(returned, new Map(), parsers, core.applyEventSessionMeta)[0];
  assert.equal(full.content, "sample.txt");
  assert.equal(full.sessionId, returned.sessionId);
  const reverse = queryRecentEvents({ files: [statFile(f.chat)], parsers, filters: { order: "desc" }, limit: 100 });
  assert.equal(reverse.events[0].content, "Found sample.txt");
  assert.equal(reverse.events.find((e) => e.callType === "Tool_Result").toolName, "list_files");
});

test("summary refreshes when only Grok usage changes and never counts cached input twice", (t) => {
  const f = fixture(t);
  const store = createSummaryStore({ parsers, now: () => Date.parse("2026-09-11T03:00:00Z") });
  const get = () => store.getSummary({ files: listSourceFileRecords(), threadMeta: new Map() });
  const first = get();
  assert.equal(first.sessions.groups.length, 2);
  const grok = first.sessions.groups.find((s) => s.sourceType === "grok");
  assert.equal(grok.aggregateToken.total, 120);
  assert.equal(first.tokens.windows.day.inputTotal, 100);
  const ag = first.sessions.groups.find((s) => s.sourceType === "antigravity");
  assert.equal(core.hasTokenUsageData(ag.aggregateToken), false);
  assert.deepEqual(ag.models, []);
  f.ledger.turns[0].inputTokens = 1100;
  f.ledger.turns[0].totalTokens = 1120;
  f.write(f.usage, f.ledger, false);
  assert.equal(get().sessions.groups.find((s) => s.sourceType === "grok").aggregateToken.total, 1120);
  // Missing or ambiguous ledger records must not become a zero token measurement.
  f.write(f.usage, { turns: [{ ...f.ledger.turns[0], turnNumber: 99 }] }, false);
  assert.equal(core.hasTokenUsageData(get().sessions.groups.find((s) => s.sourceType === "grok").aggregateToken), false);
});

test("Antigravity falls back to full transcript and keeps desktop and CLI sessions separate", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.ag);
  const cli = path.join(config.ANTIGRAVITY_CLI_BRAIN_DIR, "synthetic-session", ".system_generated", "logs", "transcript.jsonl");
  f.write(cli, [{ type: "USER_INPUT", source: "USER_EXPLICIT", content: "CLI demo", created_at: "2026-09-11T00:00:00Z" }]);
  const files = listSourceFileRecords();
  assert.ok(files.some((r) => r.file.endsWith("transcript_full.jsonl")));
  assert.notEqual(providerContext(cli).sessionId, providerContext(f.ag).sessionId);
});

test("new providers reject mutations before touching any source", () => {
  for (const id of ["grok:sample", "antigravity:desktop:sample"]) {
    assert.equal(sessionOps.renameSession(id, "changed", () => {}).success, false);
    assert.equal(sessionOps.deleteSession(id, () => {}).success, false);
  }
});

test("provider usage keeps explicit zero and rejects inconsistent or oversized cache totals", (t) => {
  const f = fixture(t);
  const readUsage = () => queryRecentEvents({ files: [statFile(f.events)], parsers, filters: { order: "asc" } }).events.filter((e) => e.callType === "Token_Usage");
  for (const change of [{ totalTokens: 1 }, { cachedReadTokens: 101 }]) {
    f.write(f.usage, { turns: [{ ...f.ledger.turns[0], ...change }] }, false);
    assert.deepEqual(readUsage(), []);
  }
  const zero = { ...f.ledger.turns[0], inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  f.write(f.usage, { turns: [zero] }, false);
  const [event] = readUsage();
  assert.equal(event.tokenUsage.total, 0);
  assert.equal(event.tokenUsage.cacheReadInput, 0);
});

test("Antigravity strips sensitive structured tool fields while retaining ordinary arguments", () => {
  const events = parseAntigravityLineToEvent({
    type: "PLANNER_RESPONSE", source: "MODEL",
    tool_calls: [{ name: "example", args: { api_key: "synthetic-private", headers: { Authorization: "synthetic-bearer", Accept: "text/plain" }, path: "/safe" } }],
  });
  assert.ok(!JSON.stringify(events).includes("synthetic-private"));
  assert.ok(!JSON.stringify(events).includes("synthetic-bearer"));
  assert.ok(events[0].content.includes("/safe"));
});

test("forward provider streams bound oversized records and keep subsequent rows readable", (t) => {
  const f = fixture(t);
  f.write(f.chat, [{ type: "assistant", content: "x".repeat(250000) }, { type: "assistant", content: "After large result" }]);
  const result = queryRecentEvents({ files: [statFile(f.chat)], parsers, filters: { order: "asc" }, maxParseLineBytes: 1024 });
  assert.ok(result.events.some((e) => e.contentTruncated));
  assert.ok(result.events.some((e) => e.content === "After large result"));
});
