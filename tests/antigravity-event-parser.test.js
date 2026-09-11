const assert = require("node:assert/strict");
const test = require("node:test");
const { parseAntigravityLineToEvent } = require("../shared/antigravity-event-parser");

const context = {
  sessionId: "conv-from-path",
  cwd: "/workspace/app",
  model: "Gemini 3.5 Flash (Medium)",
  sourceFile: "/synthetic/brain/conv/transcript.jsonl",
};

test("Antigravity parser maps a wrapped explicit instruction to a Prompt", () => {
  const events = parseAntigravityLineToEvent({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-07-05T09:14:21Z",
    content: "<USER_REQUEST>Fix the parser.\n</USER_REQUEST><ADDITIONAL_METADATA>internal</ADDITIONAL_METADATA>",
  }, context);

  assert.equal(events.length, 1);
  assert.equal(events[0].callType, "Prompt");
  assert.equal(events[0].content, "Fix the parser.");
  assert.equal(events[0].turnId, "");
  assert.equal(events[0].providerStepIndex, 0);
  assert.equal(events[0].sessionId, "conv-from-path");
  assert.equal(events[0].time, "2026-07-05T09:14:21Z");
  assert.equal(events[0].sourceFile, context.sourceFile);
});

test("Antigravity parser keeps discovery session IDs and compacts persisted content", () => {
  const longContent = "x".repeat(300);
  const events = parseAntigravityLineToEvent({
    conversation_id: "provider-conversation-id",
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: longContent,
  }, {
    ...context,
    sessionId: "antigravity:desktop:provider-conversation-id",
    compactContent: true,
    contentLimit: 120,
  });

  assert.equal(events[0].sessionId, "antigravity:desktop:provider-conversation-id");
  assert.equal(events[0].providerSessionId, "provider-conversation-id");
  assert.equal(events[0].turnId, "");
  assert.equal(events[0].providerStepIndex, 5);
  assert.equal(events[0].content, `${"x".repeat(120)}...`);
  assert.equal(events[0].summary, `${"x".repeat(220)}...`);
  assert.match(events[0].extra, /provider_session_id=provider-conversation-id/);
});

test("Antigravity parser emits actual model prose and explicit structured tool calls", () => {
  const events = parseAntigravityLineToEvent({
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-07-05T09:14:22Z",
    content: "I will update the file.",
    tool_calls: [
      {
        id: "tool-1",
        name: "write_to_file",
        args: {
          TargetFile: "\"/workspace/app/parser.js\"",
          Overwrite: "true",
        },
      },
    ],
  }, context);

  assert.equal(events.length, 2);
  assert.equal(events[0].callType, "Tool_Call");
  assert.equal(events[0].toolName, "write_to_file");
  assert.equal(events[0].callId, "tool-1");
  assert.match(events[0].content, /"TargetFile":"\/workspace\/app\/parser\.js"/);
  assert.match(events[0].content, /"Overwrite":true/);
  assert.equal(events[1].callType, "Agent");
  assert.equal(events[1].content, "I will update the file.");
});

test("Antigravity parser keeps a recorded non-DONE error without inventing a tool result", () => {
  const events = parseAntigravityLineToEvent({
    stepIndex: 9,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "FAILED",
    createdAt: "2026-07-05T09:14:24Z",
    error_message: "Provider request timed out",
  }, context);

  assert.equal(events.length, 1);
  assert.equal(events[0].callType, "Agent");
  assert.equal(events[0].content, "Provider request timed out");
  assert.match(events[0].extra, /status=FAILED/);
  assert.equal(events[0].status, "FAILED");
});

test("Antigravity parser ignores known internal checkpoints and leaves unknown prose raw", () => {
  assert.deepEqual(parseAntigravityLineToEvent({
    step_index: 1,
    source: "SYSTEM",
    type: "CHECKPOINT",
    status: "DONE",
    content: "internal summary",
  }, context), []);

  const events = parseAntigravityLineToEvent({
    step_index: 3,
    source: "MODEL",
    type: "UNRECOGNIZED_RECORD",
    status: "DONE",
    content: "Provider-specific content",
  }, context);
  assert.equal(events.length, 1);
  assert.equal(events[0].callType, "Raw");
  assert.equal(events[0].content, "Provider-specific content");
});

test("Antigravity parser maps only fixture-labeled explicit tool results", () => {
  const explicit = parseAntigravityLineToEvent({
    step_index: 7,
    source: "MODEL",
    type: "TOOL_RESULT",
    status: "FAILED",
    tool_name: "run_command",
    error_message: "Command exited with status 1",
  }, context);
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].callType, "Tool_Result");
  assert.equal(explicit[0].toolName, "run_command");
  assert.equal(explicit[0].content, "Command exited with status 1");
  assert.match(explicit[0].extra, /structured_tool_result_type=TOOL_RESULT/);

  const fieldVariant = parseAntigravityLineToEvent({
    step_index: 8,
    source: "MODEL",
    type: "VENDOR_RECORD",
    status: "DONE",
    tool_result: { name: "read_file", output: "file contents" },
  }, context);
  assert.equal(fieldVariant[0].callType, "Tool_Result");
  assert.match(fieldVariant[0].extra, /structured_tool_result_field=tool_result/);

  const ambiguous = parseAntigravityLineToEvent({
    step_index: 9,
    source: "MODEL",
    type: "TOOL_EXECUTION",
    status: "DONE",
    tool_name: "run_command",
    content: "possibly a tool result",
  }, context);
  assert.equal(ambiguous[0].callType, "Raw");
});

test("Antigravity parser never treats opaque or malformed values as content", () => {
  assert.deepEqual(parseAntigravityLineToEvent({
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: { type: "Buffer", data: [1, 2, 3] },
  }, context), []);
  assert.deepEqual(parseAntigravityLineToEvent(null, context), []);
});
