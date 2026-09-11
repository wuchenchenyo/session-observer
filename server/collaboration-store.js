const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXECUTORS = ["codex", "claude", "grok", "antigravity"];
const PERMISSIONS = ["read-only", "patch", "write"];
const EVENT_TYPES = ["started", "returned", "blocked", "reviewed", "rework", "cancelled", "session_linked"];
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_TASKS = 1000;
const MAX_EVENTS_PER_TASK = 200;
const MAX_TEXT = 4096;

function fail(message) {
  throw new Error(`Collaboration store: ${message}`);
}

function redactText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_PASSWORD)\s*[=:]\s*["']?[^\s,"']+/gi, "$1=[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED TOKEN]")
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\x2f=:-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|xai)-[A-Za-z0-9_-]{8,}\b|\b(?:ghp|glpat)_[A-Za-z0-9_-]{8,}\b|\bgithub_pat_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED TOKEN]")
    .replace(/(--(?:api[-_]?key|token|password|secret|authorization)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/(["']?(?:authorization|password|passphrase|secret|token|api[_-]?key|credential|cookie|aws_access_key_id|aws_secret_access_key|aws_session_token|database_password|client_secret|access_token|refresh_token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]");
}

function cleanText(value, field, { required = false, max = MAX_TEXT, truncate = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} must be a string`);
  const cleaned = redactText(value).trim();
  if (required && !cleaned) fail(`${field} is required`);
  if (cleaned.length > max) {
    if (!truncate) fail(`${field} exceeds ${max} characters`);
    return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
  }
  return cleaned;
}

function assertKnown(object, allowed, label) {
  if (!object || Array.isArray(object) || typeof object !== "object") fail(`${label} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${label} has unknown field ${key}`);
  }
}

function taskId(value, field) {
  const id = cleanText(value, field, { required: true, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) fail(`${field} is not a safe identifier`);
  return id;
}

function timestamp(value, field) {
  const text = cleanText(value, field, { required: true, max: 64 });
  if (!Number.isFinite(Date.parse(text))) fail(`${field} must be an ISO timestamp`);
  return text;
}

function canonicalPath(value, field) {
  const input = cleanText(value, field, { required: true, max: 1024 });
  if (!path.isAbsolute(input) || input.split(path.sep).includes("..") || input.includes("\0")) fail(`${field} must be an absolute path without traversal`);
  const normalized = path.normalize(input);
  const missing = [];
  let existing = normalized;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    existing = fs.realpathSync.native(existing);
  } catch {
    fail(`${field} cannot be canonicalized`);
  }
  return path.join(existing, ...missing);
}

function sameOrChild(left, right) {
  const relative = path.relative(right, left);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(a, b) {
  if (process.platform === "darwin" || process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return sameOrChild(a, b) || sameOrChild(b, a);
}

function evidenceItem(value, field) {
  assertKnown(value, ["label", "path", "url"], field);
  const label = cleanText(value.label, `${field}.label`, { required: true, max: 256 });
  const itemPath = cleanText(value.path, `${field}.path`, { max: 1024 });
  const url = cleanText(value.url, `${field}.url`, { max: 2048 });
  if (!itemPath && !url) fail(`${field} needs path or url`);
  return { label, ...(itemPath ? { path: itemPath } : {}), ...(url ? { url } : {}) };
}

function evidenceList(value, field) {
  if (!Array.isArray(value) || value.length > 20) fail(`${field} must contain at most 20 entries`);
  return value.map((item, index) => evidenceItem(item, `${field}[${index}]`));
}

function eventPayload(type, payload) {
  const input = payload === undefined ? {} : payload;
  const schemas = {
    started: ["brief", "command", "timeoutSeconds", "recorderPid"],
    returned: ["summary", "exitCode", "modelObserved", "artifacts", "reason", "category"],
    blocked: ["reason", "summary", "category"],
    reviewed: ["outcome", "summary", "evidence"],
    rework: ["reason", "category"],
    cancelled: ["reason", "summary"],
    session_linked: ["provider", "sessionId"],
  };
  assertKnown(input, schemas[type], `${type} payload`);
  if (type === "started") {
    const result = {};
    const brief = cleanText(input.brief, "started.brief", { max: 8192, truncate: true });
    const command = cleanText(input.command, "started.command", { max: 1024 });
    if (command && command.includes("\0")) fail("started.command contains a null byte");
    if (brief) result.brief = brief;
    if (command) result.command = command;
    if (input.timeoutSeconds !== undefined) {
      if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 86400) fail("started.timeoutSeconds must be 1..86400");
      result.timeoutSeconds = input.timeoutSeconds;
    }
    if (input.recorderPid !== undefined) {
      if (!Number.isInteger(input.recorderPid) || input.recorderPid < 1) fail("started.recorderPid must be a positive process ID");
      result.recorderPid = input.recorderPid;
    }
    return result;
  }
  if (type === "returned") {
    const summary = cleanText(input.summary, "returned.summary", { required: true, max: 8192, truncate: true });
    const result = { summary, artifacts: evidenceList(input.artifacts || [], "returned.artifacts") };
    if (input.exitCode !== undefined) {
      if (!Number.isInteger(input.exitCode) || input.exitCode < -1 || input.exitCode > 255) fail("returned.exitCode must be an integer from -1 to 255");
      result.exitCode = input.exitCode;
    }
    for (const field of ["modelObserved", "reason", "category"]) {
      const text = cleanText(input[field], `returned.${field}`, { max: field === "reason" ? MAX_TEXT : 256 });
      if (text) result[field] = text;
    }
    return result;
  }
  if (type === "blocked") {
    const reason = cleanText(input.reason || input.summary, "blocked.reason", { required: true });
    const summary = cleanText(input.summary, "blocked.summary", { max: 8192, truncate: true });
    const result = { reason, ...(summary ? { summary } : {}) };
    const category = cleanText(input.category, "blocked.category", { max: 128 });
    if (category) result.category = category;
    return result;
  }
  if (type === "reviewed") {
    const outcome = cleanText(input.outcome, "reviewed.outcome", { required: true, max: 16 });
    if (!["passed", "partial"].includes(outcome)) fail("reviewed.outcome must be passed or partial");
    const summary = cleanText(input.summary, "reviewed.summary", { required: true });
    const evidence = evidenceList(input.evidence || [], "reviewed.evidence");
    if (outcome === "passed" && (!summary || evidence.length === 0)) fail("passed review needs meaningful summary and evidence");
    return { outcome, summary, evidence };
  }
  if (type === "rework") {
    const reason = cleanText(input.reason, "rework.reason", { required: true });
    const category = cleanText(input.category, "rework.category", { max: 128 });
    return { reason, ...(category ? { category } : {}) };
  }
  if (type === "cancelled") {
    const reason = cleanText(input.reason || input.summary, "cancelled.reason", { max: MAX_TEXT });
    return reason ? { reason } : {};
  }
  const provider = cleanText(input.provider, "session_linked.provider", { required: true, max: 32 });
  if (!EXECUTORS.includes(provider)) fail("session_linked.provider is unknown");
  const sessionId = cleanText(input.sessionId, "session_linked.sessionId", { required: true, max: 512 });
  if ((provider === "grok" && !sessionId.startsWith("grok:"))
    || (provider === "antigravity" && !/^antigravity:(desktop|cli):/.test(sessionId))) {
    fail("session_linked.sessionId is not canonical for its provider");
  }
  return { provider, sessionId };
}

function normalizeTask(input, now, state) {
  assertKnown(input, ["id", "parentTaskId", "title", "executor", "modelRequested", "brief", "cwd", "writePaths", "permission"], "task");
  const id = input.id ? taskId(input.id, "task.id") : crypto.randomUUID();
  const parentTaskId = input.parentTaskId === undefined || input.parentTaskId === null ? null : taskId(input.parentTaskId, "task.parentTaskId");
  if (parentTaskId === id) fail("task cannot be its own parent");
  const parent = parentTaskId ? state.tasks.get(parentTaskId) : null;
  if (parentTaskId && !parent) fail("task parent does not exist");
  assertAncestorsOpen(state, parent);
  const title = cleanText(input.title, "task.title", { required: true, max: 256 });
  const executor = cleanText(input.executor, "task.executor", { required: true, max: 32 });
  if (!EXECUTORS.includes(executor)) fail("task.executor is unknown");
  const permission = cleanText(input.permission, "task.permission", { required: true, max: 16 });
  if (!PERMISSIONS.includes(permission)) fail("task.permission is unknown");
  const cwd = input.cwd === undefined ? undefined : canonicalPath(input.cwd, "task.cwd");
  const writePaths = input.writePaths === undefined ? [] : (() => {
    if (!Array.isArray(input.writePaths) || input.writePaths.length > 20) fail("task.writePaths must contain at most 20 paths");
    const values = input.writePaths.map((item, index) => canonicalPath(item, `task.writePaths[${index}]`));
    return [...new Set(values)].sort();
  })();
  if (permission === "read-only" && writePaths.length) fail("read-only task cannot claim writePaths");
  if (permission !== "read-only" && !writePaths.length) fail("patch/write task needs explicit writePaths");
  const modelRequested = cleanText(input.modelRequested, "task.modelRequested", { max: 256 });
  const brief = cleanText(input.brief, "task.brief", { max: 8192, truncate: true });
  return {
    id,
    parentTaskId,
    rootTaskId: parent ? parent.rootTaskId : id,
    title,
    executor,
    ...(modelRequested ? { modelRequested } : {}),
    ...(brief ? { brief } : {}),
    ...(cwd ? { cwd } : {}),
    writePaths,
    permission,
    status: "queued",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    sessions: [],
    events: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertAncestorsOpen(state, task) {
  for (let current = task; current; current = current.parentTaskId ? state.tasks.get(current.parentTaskId) : null) {
    if (["passed", "cancelled"].includes(current.status)) fail("cannot add or start work beneath a terminal ancestor");
  }
}

function applyEvent(state, record) {
  const task = state.tasks.get(record.taskId);
  if (!task) fail(`event references unknown task ${record.taskId}`);
  const type = record.type;
  if (!EVENT_TYPES.includes(type)) fail(`event type ${type} is unknown`);
  const payload = eventPayload(type, record.payload);
  const at = timestamp(record.at, "event.at");
  const children = [...state.tasks.values()].filter((candidate) => candidate.parentTaskId === task.id);
  if (type === "started") {
    if (!["queued", "rework"].includes(task.status)) fail(`cannot start task in ${task.status}`);
    if (task.events.length > MAX_EVENTS_PER_TASK - 4) fail("task event limit leaves no room for return and review");
    assertAncestorsOpen(state, task.parentTaskId ? state.tasks.get(task.parentTaskId) : null);
    assertStartAllowed(state, task);
    task.status = "running";
    task.attempt += 1;
  } else if (type === "returned") {
    if (task.status !== "running") fail(`cannot return task in ${task.status}`);
    task.status = "awaiting_review";
    if (payload.modelObserved) task.modelObserved = payload.modelObserved;
  } else if (type === "blocked") {
    if (["passed", "cancelled"].includes(task.status)) fail(`cannot block task in ${task.status}`);
    task.status = "blocked";
  } else if (type === "reviewed") {
    if (task.status !== "awaiting_review") fail(`cannot review task in ${task.status}`);
    if (payload.outcome === "passed" && children.some((child) => !["passed", "cancelled"].includes(child.status))) {
      fail("cannot pass parent before each child passed or cancelled");
    }
    task.status = payload.outcome;
  } else if (type === "rework") {
    if (!["awaiting_review", "partial", "blocked"].includes(task.status)) fail(`cannot rework task in ${task.status}`);
    task.status = "rework";
  } else if (type === "cancelled") {
    if (["passed", "cancelled"].includes(task.status)) fail(`cannot cancel task in ${task.status}`);
    if (children.some((child) => !["passed", "cancelled"].includes(child.status))) fail("cancel or finish children before cancelling the parent");
    task.status = "cancelled";
  } else {
    const existing = task.sessions.find((session) => session.provider === payload.provider && session.sessionId === payload.sessionId);
    if (!existing) task.sessions.push(payload);
  }
  task.updatedAt = at;
  if (task.events.length >= MAX_EVENTS_PER_TASK) fail("task has reached the event limit");
  task.events.push({ type, at, payload });
}

function assertStartAllowed(state, task) {
  const running = [...state.tasks.values()].filter((candidate) => candidate.status === "running");
  if (task.executor !== "codex" && running.filter((candidate) => candidate.executor !== "codex").length >= 2) {
    fail("external running limit of 2 reached");
  }
  if (!task.writePaths.length) return;
  for (const candidate of running) {
    if (!candidate.writePaths.length) continue;
    if (task.writePaths.some((target) => candidate.writePaths.some((claimed) => pathsOverlap(target, claimed)))) {
      fail(`writePaths overlap with running task ${candidate.id}`);
    }
  }
}

function createCollaborationStore({ directory }) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) fail("directory must not be a symlink");
  const base = canonicalPath(directory, "directory");
  const ledger = path.join(base, "collaboration-ledger.jsonl");
  const lock = path.join(base, ".collaboration-ledger.lock");

  function ensureStorage() {
    prepareDirectory(base, ledger);
  }

  function readState() {
    if (!fs.existsSync(base)) return { tasks: new Map(), health: new Map() };
    const baseStat = fs.lstatSync(base);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) fail("directory must be a real directory");
    if (!fs.existsSync(ledger)) return { tasks: new Map(), health: new Map() };
    return loadState(ledger);
  }

  // Opening a store never creates metadata, but an existing ledger is checked eagerly.
  readState();

  function withLock(action) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (error && error.code === "EEXIST") fail("ledger is busy; retry the operation");
      throw error;
    }
    try {
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
      return action();
    } finally {
      if (fs.existsSync(path.join(lock, "owner.json"))) fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
  }

  function append(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) fail("ledger record exceeds size limit");
    const stat = fs.statSync(ledger);
    if (stat.size + Buffer.byteLength(line) > MAX_LEDGER_BYTES) fail("ledger exceeds size limit");
    const fd = fs.openSync(ledger, "a", 0o600);
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) fail("could not complete ledger append");
        offset += written;
      }
      fs.fsyncSync(fd);
    } catch (error) {
      fs.ftruncateSync(fd, stat.size);
      fs.fsyncSync(fd);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
  }

  function createTask(input) {
    ensureStorage();
    return withLock(() => {
      const state = readState();
      if (state.tasks.size >= MAX_TASKS) fail("task limit reached");
      const now = new Date().toISOString();
      const task = normalizeTask(input, now, state);
      if (state.tasks.has(task.id)) fail("task.id already exists");
      append({ kind: "task", task });
      return clone(task);
    });
  }

  function record(taskIdValue, type, payload = {}) {
    const taskIdValueSafe = taskId(taskIdValue, "taskId");
    const eventType = cleanText(type, "event type", { required: true, max: 32 });
    if (!EVENT_TYPES.includes(eventType)) fail("event type is unknown");
    ensureStorage();
    return withLock(() => {
      const state = readState();
      const entry = { kind: "event", taskId: taskIdValueSafe, type: eventType, payload: eventPayload(eventType, payload), at: new Date().toISOString() };
      applyEvent(state, entry);
      append(entry);
      return clone(state.tasks.get(taskIdValueSafe));
    });
  }

  function recordHealth(input) {
    assertKnown(input, ["executor", "status", "category", "summary", "checkedAt"], "health");
    const executor = cleanText(input.executor, "health.executor", { required: true, max: 32 });
    if (!EXECUTORS.includes(executor)) fail("health.executor is unknown");
    const status = cleanText(input.status, "health.status", { required: true, max: 16 });
    if (!["available", "blocked", "unknown"].includes(status)) fail("health.status is unknown");
    const summary = cleanText(input.summary, "health.summary", { required: true });
    const category = cleanText(input.category, "health.category", { max: 128 });
    const checkedAt = input.checkedAt === undefined ? new Date().toISOString() : timestamp(input.checkedAt, "health.checkedAt");
    const health = { executor, status, summary, checkedAt, ...(category ? { category } : {}) };
    ensureStorage();
    return withLock(() => {
      readState();
      append({ kind: "health", health });
      return clone(health);
    });
  }

  function snapshot() {
    const state = readState();
    const tasks = [...state.tasks.values()].map((task) => {
      const copy = clone(task);
      copy.eventCount = task.events.length;
      delete copy.events;
      return copy;
    });
    const executors = EXECUTORS.map((executor) => {
      const health = state.health.get(executor);
      const running = tasks.filter((task) => task.executor === executor && task.status === "running").length;
      return { executor, status: health ? health.status : "unknown", ...(health?.category ? { category: health.category } : {}), ...(health?.summary ? { summary: health.summary } : {}), ...(health?.checkedAt ? { checkedAt: health.checkedAt } : {}), running };
    });
    const counts = {
      running: tasks.filter((task) => task.status === "running").length,
      awaitingReview: tasks.filter((task) => task.status === "awaiting_review").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      total: tasks.length,
    };
    return { tasks, executors, policy: { maxExternalRunning: 2 }, counts };
  }

  function detail(taskIdValue) {
    const task = readState().tasks.get(taskId(taskIdValue, "taskId"));
    return task ? clone(task) : null;
  }

  return { createTask, record, snapshot, detail, recordHealth };
}

function prepareDirectory(base, ledger) {
  if (fs.existsSync(base)) {
    const stat = fs.lstatSync(base);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("directory must be a real directory");
    if ((stat.mode & 0o077) !== 0) fail("existing directory is not private; choose a new dedicated directory (no permissions were changed)");
  } else {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  if (fs.existsSync(ledger)) {
    const stat = fs.lstatSync(ledger);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("ledger must be a regular file");
    if ((stat.mode & 0o077) !== 0) fail("existing ledger is not private; permissions were not changed");
  } else {
    try {
      const fd = fs.openSync(ledger, "wx", 0o600);
      fs.closeSync(fd);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(ledger);
      if (stat.isSymbolicLink() || !stat.isFile()) fail("ledger must be a regular file");
    }
  }
}

function loadState(ledger) {
  const stat = fs.lstatSync(ledger);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("ledger must be a regular file");
  if (stat.size > MAX_LEDGER_BYTES) fail("ledger exceeds size limit");
  const content = fs.readFileSync(ledger, "utf8");
  if (content && !content.endsWith("\n")) fail("ledger is truncated or has an incomplete final record");
  const state = { tasks: new Map(), health: new Map() };
  const lines = content ? content.slice(0, -1).split("\n") : [];
  for (let index = 0; index < lines.length; index += 1) {
    if (Buffer.byteLength(lines[index]) > MAX_RECORD_BYTES) fail(`ledger line ${index + 1} exceeds size limit`);
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      fail(`ledger line ${index + 1} is malformed`);
    }
    try {
      assertKnown(entry, ["kind", "task", "taskId", "type", "payload", "at", "health"], `ledger line ${index + 1}`);
      if (entry.kind === "task") {
        const task = entry.task;
        assertKnown(task, ["id", "parentTaskId", "rootTaskId", "title", "executor", "modelRequested", "brief", "cwd", "writePaths", "permission", "status", "attempt", "createdAt", "updatedAt", "sessions", "events"], "stored task");
        const rebuilt = normalizeTask({ id: task.id, parentTaskId: task.parentTaskId, title: task.title, executor: task.executor, modelRequested: task.modelRequested, brief: task.brief, cwd: task.cwd, writePaths: task.writePaths, permission: task.permission }, timestamp(task.createdAt, "stored task.createdAt"), state);
        if (task.rootTaskId !== rebuilt.rootTaskId || task.status !== "queued" || task.attempt !== 0 || task.updatedAt !== task.createdAt || !Array.isArray(task.sessions) || !Array.isArray(task.events) || task.sessions.length || task.events.length) fail("stored task is invalid");
        if (state.tasks.has(rebuilt.id)) fail("stored task id is duplicated");
        state.tasks.set(rebuilt.id, rebuilt);
      } else if (entry.kind === "event") {
        assertKnown(entry, ["kind", "taskId", "type", "payload", "at"], "stored event");
        applyEvent(state, entry);
      } else if (entry.kind === "health") {
        assertKnown(entry, ["kind", "health"], "stored health");
        assertKnown(entry.health, ["executor", "status", "category", "summary", "checkedAt"], "stored health payload");
        const health = {
          executor: cleanText(entry.health.executor, "health.executor", { required: true, max: 32 }),
          status: cleanText(entry.health.status, "health.status", { required: true, max: 16 }),
          summary: cleanText(entry.health.summary, "health.summary", { required: true }),
          checkedAt: timestamp(entry.health.checkedAt, "health.checkedAt"),
          ...(entry.health.category ? { category: cleanText(entry.health.category, "health.category", { max: 128 }) } : {}),
        };
        if (!EXECUTORS.includes(health.executor) || !["available", "blocked", "unknown"].includes(health.status)) fail("stored health is invalid");
        state.health.set(health.executor, health);
      } else {
        fail("ledger has an unknown record kind");
      }
    } catch (error) {
      if (String(error.message || error).startsWith("Collaboration store:")) throw error;
      fail(`ledger line ${index + 1} is invalid`);
    }
  }
  return state;
}

module.exports = { createCollaborationStore, redactText };
