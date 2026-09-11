const assert = require("node:assert/strict");
const test = require("node:test");
const { parseGrokLineToEvent } = require("../shared/grok-event-parser");

function context(overrides = {}) {
  return {
    sessionId: "grok-session",
    cwd: "/workspace/grok",
    model: "grok-4",
    time: "2026-09-11T01:00:00.000Z",
    sessionTitle: "Grok parser fixture",
    sourceFile: "chat_history.jsonl",
    ...overrides,
  };
}

test("parses system and user chat history rows with recorded times", () => {
  const ctx = context();
  const system = parseGrokLineToEvent({
    type: "system",
    timestamp: "2026-09-11T01:01:00.000Z",
    content: "You are a helpful assistant.",
  }, ctx)[0];
  const user = parseGrokLineToEvent({
    type: "user",
    content: [{ type: "text", text: "Find the deployment error." }],
  }, ctx)[0];

  assert.equal(system.callType, "System");
  assert.equal(system.time, "2026-09-11T01:01:00.000Z");
  assert.equal(user.callType, "Prompt");
  assert.equal(user.content, "Find the deployment error.");
  assert.equal(user.time, "2026-09-11T01:00:00.000Z");
  assert.equal(user.timeSource, "session");
  assert.match(user.extra, /time=session/);
});

test("splits assistant output into paired tool calls and an agent message", () => {
  const ctx = context();
  const events = parseGrokLineToEvent({
    type: "assistant",
    timestamp: "2026-09-11T01:02:00.000Z",
    model_id: "grok-4.1",
    content: "I will inspect both files.",
    tool_calls: [
      { id: "call-read", name: "Read", arguments: "{\"path\":\"a.js\"}" },
      { id: "call-search", name: "Search", arguments: "{partial" },
    ],
  }, ctx);
  const result = parseGrokLineToEvent({
    type: "tool_result",
    tool_call_id: "call-read",
    content: "file contents",
  }, ctx)[0];

  assert.deepEqual(events.map((event) => event.callType), ["Tool_Call", "Tool_Call", "Agent"]);
  assert.equal(events[0].callId, "call-read");
  assert.equal(events[1].content, "tool=Search\nargs={partial");
  assert.equal(events[2].model, "grok-4.1");
  assert.equal(result.callType, "Tool_Result");
  assert.equal(result.callId, "call-read");
  assert.equal(result.toolName, "Read");
});

test("removes sensitive keys from string-form tool arguments", () => {
  const event = parseGrokLineToEvent({
    type: "assistant",
    tool_calls: [{ id: "call-sensitive", name: "Request", arguments: '{"authorization":"do-not-show","path":"safe"}' }],
  }, context())[0];

  assert.equal(event.content, "tool=Request\nargs={\"path\":\"safe\"}");
  assert.doesNotMatch(event.content, /authorization|do-not-show/);
});

test("uses recorded tool completions and only joins usage at the exact ended timestamp", () => {
  const ctx = context({
    grokToolCompletions: new Map([["call-read", {
      ts: "2026-09-11T01:02:05.000Z",
      duration_ms: 240,
      outcome: "completed",
      tool_name: "Read",
    }]]),
    grokUsageByEndTime: new Map([["2026-09-11T01:03:00.000Z", {
      inputTokens: 10,
      outputTokens: 4,
      cachedReadTokens: 3,
      cacheCreationTokens: 1,
      reasoningTokens: 2,
      totalTokens: 14,
      costUsdTicks: 999,
    }]]),
  });
  parseGrokLineToEvent({
    type: "assistant",
    tool_calls: [{ id: "call-read", name: "Read", arguments: "{}" }],
  }, ctx);
  const result = parseGrokLineToEvent({ type: "tool_result", tool_call_id: "call-read", content: "ok" }, ctx)[0];
  const usage = parseGrokLineToEvent({ type: "turn_ended", ts: "2026-09-11T01:03:00.000Z" }, ctx)[0];

  assert.equal(result.time, "2026-09-11T01:00:00.000Z");
  assert.equal(result.timeSource, "session");
  assert.equal(result.completedAt, "2026-09-11T01:02:05.000Z");
  assert.equal(result.durationMs, 240);
  assert.match(result.extra, /duration_ms=240/);
  assert.match(result.extra, /outcome=completed/);
  assert.equal(usage.callType, "Token_Usage");
  assert.deepEqual(usage.tokenUsage, {
    input: 10,
    output: 4,
    cacheReadInput: 3,
    cacheCreationInput: 1,
    reasoningOutput: 2,
    total: 14,
  });
  assert.doesNotMatch(JSON.stringify(usage), /costUsdTicks/);
  assert.deepEqual(parseGrokLineToEvent({ type: "turn_ended", ts: "2026-09-11T01:03:01.000Z" }, ctx), []);
});

test("keeps the prefixed session id and supports reverse-scan tool result context", () => {
  const ctx = context({
    sessionId: "grok:session-uuid",
    grokToolCompletions: {
      "call-reverse": { tool_name: "Shell", ts: "2026-09-11T01:05:00.000Z" },
    },
  });
  const result = parseGrokLineToEvent({
    type: "tool_result",
    session_id: "unprefixed-source-id",
    tool_call_id: "call-reverse",
    content: "done",
  }, ctx)[0];

  assert.equal(result.sessionId, "grok:session-uuid");
  assert.equal(result.toolName, "Shell");
});

test("compacts large Grok fields for summary contexts", () => {
  const large = "x".repeat(500);
  const ctx = context({ compactContent: true, contentLimit: 120 });
  const agent = parseGrokLineToEvent({ type: "assistant", content: large }, ctx)[0];
  const tool = parseGrokLineToEvent({
    type: "assistant",
    tool_calls: [{ id: "call-large", name: "Write", arguments: large }],
  }, ctx)[0];
  const reasoning = parseGrokLineToEvent({
    type: "reasoning",
    summary: [{ type: "summary_text", text: large }],
  }, ctx)[0];

  assert.equal(agent.content.length, 123);
  assert.equal(tool.content.length, 139);
  assert.equal(reasoning.content.length, 123);
  assert.equal(agent.content.endsWith("..."), true);
});

test("updates lifecycle model and emits only failed or cancelled turn outcomes", () => {
  const ctx = context({ model: "old-model" });
  assert.deepEqual(parseGrokLineToEvent({ type: "turn_started", model_id: "grok-live" }, ctx), []);
  assert.equal(ctx.model, "grok-live");
  const failed = parseGrokLineToEvent({ type: "turn_ended", ts: "2026-09-11T01:04:00.000Z", outcome: "failed" }, ctx);

  assert.equal(failed.length, 1);
  assert.equal(failed[0].callType, "System");
  assert.match(failed[0].content, /failed/);
  assert.deepEqual(parseGrokLineToEvent({ type: "turn_ended", outcome: "completed" }, ctx), []);
});

test("emits backend tool calls only from observed fields", () => {
  const ctx = context();
  const named = parseGrokLineToEvent({
    type: "backend_tool_call",
    timestamp: "2026-09-11T01:03:00.000Z",
    tool_type: "computer",
    call_id: "backend-1",
    name: "open_file",
    input: { path: "src/app.js", auth: "omit-me" },
  }, ctx)[0];
  const action = parseGrokLineToEvent({
    kind: {
      type: "backend_tool_call",
      tool_type: "web",
      id: "backend-2",
      action: { type: "search", query: "Grok parser", sources: ["web"] },
      status: "running",
    },
  }, ctx)[0];

  assert.equal(named.callType, "Tool_Call");
  assert.equal(named.callId, "backend-1");
  assert.equal(named.toolName, "open_file");
  assert.match(named.content, /src\/app\.js/);
  assert.doesNotMatch(named.content, /omit-me|auth/);
  assert.equal(action.callId, "backend-2");
  assert.equal(action.toolName, "search");
  assert.match(action.content, /Grok parser/);
  assert.match(action.extra, /status=running/);
  assert.doesNotMatch(action.content, /result|success/i);
});

test("uses reasoning summaries without exposing encrypted content", () => {
  const events = parseGrokLineToEvent({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Checked the parser shape." }],
    encrypted_content: "must-not-leak",
  }, context());

  assert.equal(events[0].callType, "Thinking");
  assert.equal(events[0].content, "Checked the parser shape.");
  assert.doesNotMatch(JSON.stringify(events[0]), /encrypted|must-not-leak/);
  assert.deepEqual(parseGrokLineToEvent({
    type: "reasoning",
    encrypted_content: "only-secret-data",
  }, context()), []);
});

test("handles missing content and unsupported or malformed rows safely", () => {
  const missing = parseGrokLineToEvent({ type: "tool_result", tool_call_id: "missing" }, context({ time: "" }))[0];

  assert.equal(missing.callType, "Tool_Result");
  assert.equal(missing.content, "");
  assert.equal(missing.time, "");
  assert.equal(missing.timeSource, "missing");
  assert.match(missing.extra, /time=missing/);
  assert.deepEqual(parseGrokLineToEvent({ type: "usage", token_count: 12 }, context()), []);
  assert.deepEqual(parseGrokLineToEvent(null, context()), []);
  assert.deepEqual(parseGrokLineToEvent("not-an-object", context()), []);
});

test("does not convert absent or nonnumeric usage values into zero", () => {
  const ctx = context({
    grokUsageByEndTime: {
      "2026-09-11T01:06:00.000Z": {
        inputTokens: null,
        outputTokens: "",
        cachedReadTokens: false,
        cacheCreationTokens: 0,
        reasoningTokens: "3",
        totalTokens: -1,
      },
    },
  });
  const event = parseGrokLineToEvent({ type: "turn_ended", ts: "2026-09-11T01:06:00.000Z" }, ctx)[0];

  assert.deepEqual(event.tokenUsage, {
    input: null,
    output: null,
    cacheReadInput: null,
    cacheCreationInput: 0,
    reasoningOutput: 3,
    total: null,
  });
});
