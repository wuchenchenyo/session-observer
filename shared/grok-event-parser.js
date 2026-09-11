function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanValue(value, seen = new WeakSet()) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, seen));
  if (!isObject(value) || seen.has(value)) return undefined;

  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(auth|encrypted|password|secret|credential|api[-_]?key|access[-_]?token)/i.test(key)) continue;
    const cleaned = cleanValue(item, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  seen.delete(value);
  return out;
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => isObject(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function stringifyInput(value) {
  if (typeof value === "string") {
    try {
      return stringifyInput(JSON.parse(value));
    } catch {
      return /(?:^|[,{]\s*)["']?(?:auth|encrypted|password|secret|credential|api[-_]?key|access[-_]?token)["']?\s*[:=]/i.test(value)
        ? ""
        : value;
    }
  }
  if (value == null) return "";
  try {
    const cleaned = cleanValue(value);
    return cleaned === undefined ? "" : JSON.stringify(cleaned);
  } catch {
    return "";
  }
}

function timeFor(obj, context) {
  const recorded = obj.timestamp || obj.ts || obj.time || obj.created_at || obj.createdAt;
  if (recorded) return { time: String(recorded), source: "record" };
  if (context.time) return { time: String(context.time), source: "context" };
  return { time: "", source: "missing" };
}

function timeExtra(source, extra = "") {
  const timeNote = source === "record" ? "" : source === "context"
    ? "time=session fallback_time"
    : "time=missing";
  return [extra, timeNote].filter(Boolean).join(" ");
}

function summary(content, max = 220) {
  const normalized = String(content || "").trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function parserContentLimit(context, fallback = 1000) {
  const value = Number(context?.contentLimit ?? context?.contentPreviewLength);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(16000, Math.max(120, Math.floor(value)));
}

function compactTextForContext(value, context, fallbackLimit = 1000) {
  const text = String(value || "");
  if (!context?.compactContent) return text;
  const limit = parserContentLimit(context, fallbackLimit);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function contextMap(context) {
  const keys = ["grokToolNamesByCallId", "toolNamesByCallId", "toolNameByCallId"];
  for (const key of keys) {
    const value = context[key];
    if (value instanceof Map || isObject(value)) return value;
  }
  context.grokToolNamesByCallId = new Map();
  return context.grokToolNamesByCallId;
}

function rememberToolName(context, callId, toolName) {
  if (!callId || !toolName) return;
  const names = contextMap(context);
  if (names instanceof Map) names.set(callId, toolName);
  else names[callId] = toolName;
}

function knownToolName(context, callId) {
  if (!callId) return "";
  const names = contextMap(context);
  return names instanceof Map ? String(names.get(callId) || "") : String(names[callId] || "");
}

function baseEvent(obj, context, fields = {}) {
  const timestamp = timeFor(obj, context);
  const model = obj.model_id || obj.model || context.model || "unknown";
  if (obj.model_id || obj.model) context.model = model;
  return {
    time: timestamp.time,
    sessionId: context.sessionId || obj.session_id || obj.sessionId || "unknown",
    model,
    turnId: obj.turn_id || obj.turnId || obj.message_id || "",
    callId: "",
    toolName: "",
    cwd: obj.cwd || context.cwd || "",
    sessionTitle: obj.title || context.sessionTitle || context.title || "",
    sourceFile: context.sourceFile || "unknown",
    sourceType: "grok",
    timeSource: timestamp.source === "context" ? "session" : timestamp.source,
    ...fields,
    extra: timeExtra(timestamp.source, fields.extra),
  };
}

function toolCallEvent(obj, context, call) {
  const callId = String(call.call_id || call.id || "");
  const toolName = String(call.name || call.action?.type || call.tool_type || "");
  const input = Object.hasOwn(call, "arguments") ? call.arguments
    : Object.hasOwn(call, "input") ? call.input
      : call.action;
  const args = compactTextForContext(stringifyInput(input), context);
  rememberToolName(context, callId, toolName);
  return baseEvent(obj, context, {
    callId,
    toolName,
    callType: "Tool_Call",
    rawType: "backend_tool_call",
    rawSubType: "",
    extra: call.status == null ? "" : `status=${String(call.status)}`,
    content: args ? `tool=${toolName}\nargs=${args}` : `tool=${toolName}`,
    summary: summary(`tool=${toolName}`),
  });
}

function backendCall(obj) {
  if (obj.type === "backend_tool_call") return isObject(obj.kind) ? obj.kind : obj;
  if (obj.kind === "backend_tool_call") return obj;
  if (isObject(obj.kind) && obj.kind.type === "backend_tool_call") return obj.kind;
  return null;
}

function lookup(context, key, value) {
  const source = context?.[key];
  if (source instanceof Map) return source.get(value);
  if (isObject(source)) return source[value];
  return undefined;
}

function finiteNonNegative(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenUsageEvent(obj, context, usage) {
  const tokenUsage = {
    input: finiteNonNegative(usage.inputTokens),
    output: finiteNonNegative(usage.outputTokens),
    cacheReadInput: finiteNonNegative(usage.cachedReadTokens),
    cacheCreationInput: finiteNonNegative(usage.cacheCreationTokens),
    reasoningOutput: finiteNonNegative(usage.reasoningTokens),
    total: finiteNonNegative(usage.totalTokens),
  };
  if (Object.values(tokenUsage).every((value) => value == null)) return null;
  const { input, output, total, cacheReadInput, cacheCreationInput } = tokenUsage;
  if (input != null && output != null && total != null && total !== input + output) return null;
  if (input != null && (cacheReadInput || 0) + (cacheCreationInput || 0) > input) return null;
  const details = [
    ["In", tokenUsage.input],
    ["Out", tokenUsage.output],
    ["Total", tokenUsage.total],
    ["Cache read", tokenUsage.cacheReadInput],
    ["Cache write", tokenUsage.cacheCreationInput],
    ["Reason", tokenUsage.reasoningOutput],
  ].filter(([, value]) => value != null).map(([label, value]) => `${label} ${value}`);
  return baseEvent(obj, context, {
    callType: "Token_Usage",
    rawType: "turn_ended",
    rawSubType: "usage_join",
    model: usage.primaryModelId || context.model || "unknown",
    content: `Token usage${details.length ? ` · ${details.join(" · ")}` : ""}`,
    summary: "Token usage",
    tokenUsage,
  });
}

function turnEndedEvents(obj, context) {
  const events = [];
  const usage = lookup(context, "grokUsageByEndTime", obj.ts);
  if (usage) {
    const tokenEvent = tokenUsageEvent(obj, context, usage);
    if (tokenEvent) events.push(tokenEvent);
  }
  const outcome = String(obj.outcome || obj.status || "").toLowerCase();
  if (outcome === "failed" || outcome === "cancelled") {
    const content = `Turn ${outcome}`;
    events.push(baseEvent(obj, context, {
      callType: "System",
      rawType: "turn_ended",
      rawSubType: outcome,
      extra: `outcome=${outcome}`,
      content,
      summary: content,
    }));
  }
  return events;
}

function parseGrokLineToEvent(obj, context = {}) {
  if (!isObject(obj)) return [];

  if (obj.type === "turn_started") {
    if (obj.model_id || obj.model) context.model = obj.model_id || obj.model;
    return [];
  }
  if (obj.type === "turn_ended") return turnEndedEvents(obj, context);

  const backend = backendCall(obj);
  if (backend) return [toolCallEvent(obj, context, backend)];

  switch (obj.type) {
    case "system": {
      const content = compactTextForContext(textContent(obj.content), context);
      return [baseEvent(obj, context, {
        callType: "System",
        rawType: "system",
        rawSubType: "",
        content,
        summary: summary(content),
      })];
    }
    case "user": {
      const content = compactTextForContext(textContent(obj.content), context);
      return [baseEvent(obj, context, {
        callType: "Prompt",
        rawType: "user",
        rawSubType: "",
        content,
        summary: summary(content),
      })];
    }
    case "assistant": {
      const content = compactTextForContext(textContent(obj.content), context);
      const events = [];
      for (const call of Array.isArray(obj.tool_calls) ? obj.tool_calls : []) {
        if (isObject(call)) events.push(toolCallEvent(obj, context, call));
      }
      if (content) {
        events.push(baseEvent(obj, context, {
          callType: "Agent",
          rawType: "assistant",
          rawSubType: "",
          content,
          summary: summary(content),
        }));
      }
      return events;
    }
    case "tool_result": {
      const callId = String(obj.tool_call_id || obj.call_id || obj.id || "");
      const completion = lookup(context, "grokToolCompletions", callId);
      const toolName = String(obj.name || knownToolName(context, callId) || completion?.tool_name || "");
      const content = compactTextForContext(textContent(obj.content), context);
      const extras = [];
      if (finiteNonNegative(completion?.duration_ms) != null) extras.push(`duration_ms=${completion.duration_ms}`);
      if (completion?.outcome != null) extras.push(`outcome=${String(completion.outcome)}`);
      return [baseEvent(obj, context, {
        callId,
        toolName,
        callType: "Tool_Result",
        rawType: "tool_result",
        rawSubType: "",
        extra: extras.join(" "),
        completedAt: typeof completion?.ts === "string" ? completion.ts : "",
        durationMs: finiteNonNegative(completion?.duration_ms),
        outcome: completion?.outcome == null ? "" : String(completion.outcome),
        content,
        summary: summary(content),
      })];
    }
    case "reasoning": {
      const content = Array.isArray(obj.summary)
        ? obj.summary
          .filter((item) => isObject(item) && item.type === "summary_text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n")
        : "";
      if (!content) return [];
      const compactContent = compactTextForContext(content, context, 300);
      return [baseEvent(obj, context, {
        callType: "Thinking",
        rawType: "reasoning",
        rawSubType: "summary",
        content: compactContent,
        summary: summary(compactContent),
      })];
    }
    default:
      return [];
  }
}

module.exports = { parseGrokLineToEvent };
