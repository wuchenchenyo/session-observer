/** Read-only metadata for providers whose session identity is stored outside each row. */
const fs = require("fs");
const path = require("path");
const config = require("./config");

function inside(file, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function providerForFile(file) {
  if (inside(file, config.GROK_SESSIONS_DIR) || String(file).replace(/\\/g, "/").includes("/.grok/sessions/")) return "grok";
  if ([config.ANTIGRAVITY_BRAIN_DIR, config.ANTIGRAVITY_CLI_BRAIN_DIR].some((dir) => inside(file, dir))
    || /\/\.gemini\/antigravity(?:-cli)?\/brain\//.test(String(file).replace(/\\/g, "/"))) return "antigravity";
  return "";
}

function signature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function providerSignature(file) {
  if (providerForFile(file) !== "grok") return "";
  return ["summary.json", "usage.json", "events.jsonl"].map((name) => signature(path.join(path.dirname(file), name))).join("|");
}

function readObject(file, limit = 8 * 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limit) return {};
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const metadataCache = new Map();
function providerContext(file) {
  const provider = providerForFile(file);
  if (!provider) return {};
  if (provider === "antigravity") {
    const normalized = String(file).replace(/\\/g, "/");
    const match = normalized.match(/\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/);
    const surface = inside(file, config.ANTIGRAVITY_CLI_BRAIN_DIR) || normalized.includes("/antigravity-cli/") ? "cli" : "desktop";
    return { sourceType: provider, sessionId: `antigravity:${surface}:${match?.[1] || path.basename(path.dirname(file))}` };
  }
  const directory = path.dirname(file);
  const key = providerSignature(file);
  const cached = metadataCache.get(directory);
  if (cached?.key === key) return { ...cached.context };
  const summary = readObject(path.join(directory, "summary.json"));
  const usage = readObject(path.join(directory, "usage.json"));
  const grokUsageByEndTime = Object.create(null);
  const turns = Array.isArray(usage.turns) ? usage.turns : [];
  let currentTurnNumber = null;
  const grokToolCompletions = Object.create(null);
  // Only lifecycle metadata is retained, never prompts, results, environment or headers.
  // The streaming scanner is loaded lazily to avoid a scanner/context import cycle.
  const eventsFile = path.join(directory, "events.jsonl");
  if (fs.existsSync(eventsFile)) {
    try {
      require("./fs-scanner").forEachCompleteJsonlLine(eventsFile, (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "turn_started") currentTurnNumber = Number.isInteger(event.turn_number) ? event.turn_number : null;
          if (event.type === "turn_ended") {
            // Grok Build 1.0.x numbers events from zero and ledger turns from one.
            // The ledger is flushed shortly AFTER turn_ended, not at the same timestamp.
            // Require both identity and an unambiguous adjacent timestamp; never guess
            // a usage entry from ordering alone when formats or historical logs differ.
            const matches = turns.filter((turn) => {
              const delta = Date.parse(turn?.endedAt) - Date.parse(event.ts);
              return currentTurnNumber != null && turn?.turnNumber === currentTurnNumber + 1
                && Number.isFinite(delta) && delta >= 0 && delta <= 1000;
            });
            if (matches.length === 1) grokUsageByEndTime[event.ts] = matches[0];
            currentTurnNumber = null;
          }
          if (event.type === "tool_completed" && typeof event.tool_call_id === "string") {
            grokToolCompletions[event.tool_call_id] = {
              ts: event.ts, duration_ms: event.duration_ms, outcome: event.outcome, tool_name: event.tool_name,
            };
          }
        } catch { /* Ignore partial/invalid records. */ }
      }, { maxLineBytes: 128 * 1024 });
    } catch { /* A concurrently rotated log must not prevent reading chat history. */ }
  }
  const context = {
    sourceType: "grok",
    sessionId: `grok:${summary.info?.id || path.basename(directory)}`,
    cwd: typeof summary.info?.cwd === "string" ? summary.info.cwd : "",
    sessionTitle: typeof summary.session_summary === "string" ? summary.session_summary : "",
    model: typeof summary.current_model_id === "string" ? summary.current_model_id : "unknown",
    time: typeof summary.created_at === "string" ? summary.created_at : "",
    grokUsageByEndTime,
    grokToolCompletions,
  };
  if (metadataCache.size >= 128) metadataCache.delete(metadataCache.keys().next().value);
  metadataCache.set(directory, { key, context });
  return { ...context };
}

module.exports = { providerForFile, providerContext, providerSignature };
