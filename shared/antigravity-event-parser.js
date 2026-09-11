"use strict";

// Antigravity writes plaintext trajectory records to transcript.jsonl. This
// adapter intentionally reads only JSON already supplied by the JSONL reader;
// it does not inspect opaque conversation stores or attempt to decode blobs.

const INTERNAL_SYSTEM_TYPES = new Set([
  "CHECKPOINT",
  "CONVERSATION_HISTORY",
  "SYSTEM_MESSAGE",
]);

// These labels are defensive compatibility variants. The transcript shapes
// captured for this adapter have tool_calls on PLANNER_RESPONSE, but have not
// established a separate tool-result record type yet.
const FIXTURE_ONLY_TOOL_RESULT_TYPES = new Set([
  "TOOL_RESULT",
  "TOOL_CALL_RESULT",
  "TOOL_RESPONSE",
  "TOOL_OUTPUT",
  "FUNCTION_RESULT",
]);

function textValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => textValue(entry?.text ?? entry?.content ?? entry))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function cleanUserRequest(content) {
  const raw = textValue(content);
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return match ? match[1] : raw;
}

function parseJsonString(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^(?:\{|\[|"|true$|false$|null$|-?\d+(?:\.\d+)?$)/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeToolArgs(value) {
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) return parsed.map(normalizeToolArgs);
  if (!parsed || typeof parsed !== "object") return parsed;
  return Object.fromEntries(Object.entries(parsed)
    .filter(([key]) => !/(auth|encrypted|password|secret|credential|api[-_]?key|access[-_]?token)/i.test(key))
    .map(([key, entry]) => [key, normalizeToolArgs(entry)]));
}

function stringifyStructured(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function explicitToolCalls(obj) {
  const entries = Array.isArray(obj?.tool_calls)
    ? obj.tool_calls
    : obj?.tool_call && typeof obj.tool_call === "object"
      ? [obj.tool_call]
      : [];
  return entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: textValue(entry.name ?? entry.tool_name ?? entry.tool?.name ?? entry.function?.name),
      id: textValue(entry.id ?? entry.call_id ?? entry.tool_call_id),
      args: normalizeToolArgs(entry.args ?? entry.arguments ?? entry.input ?? entry.tool?.args ?? entry.function?.arguments),
    }))
    .filter((entry) => entry.name);
}

function errorText(obj) {
  return textValue(obj?.error_details ?? obj?.error_message ?? obj?.error ?? obj?.failure_reason);
}

function contentLimit(context, fallback = 1000) {
  const value = Number(context?.contentLimit ?? context?.contentPreviewLength);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(16000, Math.max(120, Math.floor(value)));
}

function contentForContext(value, context) {
  const content = String(value || "");
  if (!context?.compactContent) return content;
  const limit = contentLimit(context);
  return content.length > limit ? `${content.slice(0, limit)}...` : content;
}

function recordExtra(source, type, status, providerSessionId, stepIndex) {
  return [
    source && `source=${source}`,
    type && `type=${type}`,
    status && `status=${status}`,
    providerSessionId && `provider_session_id=${providerSessionId}`,
    stepIndex != null && `provider_step_index=${stepIndex}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function clip(text, limit = 220) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

function explicitToolResult(obj, type) {
  const resultField = ["tool_result", "toolResult", "tool_output", "toolOutput"]
    .find((field) => Object.prototype.hasOwnProperty.call(obj, field));
  if (!FIXTURE_ONLY_TOOL_RESULT_TYPES.has(type) && !resultField) return null;

  const result = resultField ? obj[resultField] : obj;
  const content = textValue(
    result?.output ?? result?.content ?? result?.result ?? result?.text ?? (typeof result === "string" ? result : obj.content),
  ) || errorText(result) || errorText(obj);
  if (!content) return null;
  return {
    content,
    name: textValue(result?.name ?? result?.tool_name ?? obj.tool_name ?? obj.toolName),
    id: textValue(result?.id ?? result?.call_id ?? result?.tool_call_id ?? obj.call_id ?? obj.tool_call_id),
    provenance: resultField
      ? `structured_tool_result_field=${resultField}`
      : `structured_tool_result_type=${type}`,
  };
}

function parseAntigravityLineToEvent(obj, context = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];

  const source = textValue(obj.source).toUpperCase();
  const type = textValue(obj.type).toUpperCase();
  const status = textValue(obj.status).toUpperCase();
  const providerSessionId = textValue(obj.conversation_id ?? obj.conversationId ?? obj.session_id ?? obj.sessionId);
  const sessionId = context.sessionId || providerSessionId || "unknown";
  const model = textValue(obj.model?.id ?? obj.model ?? obj.metadata?.model?.id ?? obj.metadata?.model) || context.model || "unknown";
  const cwd = textValue(obj.cwd ?? obj.workspace?.current_dir ?? obj.workspace?.project_dir) || context.cwd || "";
  const time = textValue(obj.created_at ?? obj.createdAt ?? obj.timestamp ?? obj.time);
  const stepIndex = Number.isInteger(obj.step_index) ? obj.step_index : Number.isInteger(obj.stepIndex) ? obj.stepIndex : null;
  const turnId = "";
  const sourceType = context.sourceType || "antigravity";
  const sourceFile = context.sourceFile;
  const sessionTitle = context.sessionTitle || "";
  const extra = recordExtra(source, type, status, providerSessionId, stepIndex);
  const rawContent = textValue(obj.content);
  const failure = errorText(obj);
  const tools = explicitToolCalls(obj);
  const toolResult = explicitToolResult(obj, type);

  // These records carry Antigravity's own context/checkpoint bookkeeping, not
  // visible conversation messages. Keeping them out also avoids treating a
  // generated summary as a user or model reply.
  if (source === "SYSTEM" && INTERNAL_SYSTEM_TYPES.has(type)) return [];

  const base = {
    time,
    sessionId,
    model,
    turnId,
    callId: "",
    toolName: "",
    cwd,
    sessionTitle,
    extra,
    sourceFile,
    sourceType,
    rawType: type,
    rawSubType: source,
    status,
    providerStepIndex: stepIndex,
    providerSessionId,
  };
  const events = [];

  if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
    const raw = cleanUserRequest(rawContent) || failure;
    const content = contentForContext(raw, context);
    if (content) events.push({
      ...base,
      callType: "Prompt",
      content,
      summary: clip(raw),
    });
    return events;
  }

  const isPlannerResponse = source === "MODEL" && type === "PLANNER_RESPONSE";
  if (isPlannerResponse || tools.length > 0) {
    for (const tool of tools) {
      const args = stringifyStructured(tool.args);
      const raw = args ? `tool=${tool.name}\nargs=${args}` : `tool=${tool.name}`;
      const content = contentForContext(raw, context);
      events.push({
        ...base,
        callId: tool.id,
        toolName: tool.name,
        callType: "Tool_Call",
        content,
        summary: clip(raw),
      });
    }
    if (isPlannerResponse && (rawContent || failure)) {
      const raw = rawContent || failure;
      const content = contentForContext(raw, context);
      events.push({
        ...base,
        callType: "Agent",
        content,
        summary: clip(raw),
      });
    }
    return events;
  }

  if (toolResult) {
    const raw = toolResult.content;
    const content = contentForContext(raw, context);
    return [{
      ...base,
      callId: toolResult.id,
      toolName: toolResult.name,
      extra: [extra, toolResult.provenance].filter(Boolean).join(" · "),
      callType: "Tool_Result",
      content,
      summary: clip(raw),
    }];
  }

  // Preserve content from schema variants as a raw provider record. It remains
  // searchable/reviewable without inventing a role, tool result, token count,
  // or a meaning for an unrecognised status.
  const raw = rawContent || failure;
  const content = contentForContext(raw, context);
  if (!content) return [];
  return [{
    ...base,
    callType: source === "SYSTEM" ? "System" : "Raw",
    content,
    summary: clip(raw),
  }];
}

module.exports = { parseAntigravityLineToEvent };
