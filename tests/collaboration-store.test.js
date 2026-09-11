const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCollaborationStore, redactText } = require("../server/collaboration-store");

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "observer-collaboration-"));
}

function task(overrides = {}) {
  return {
    title: "Inspect the local service",
    executor: "codex",
    permission: "read-only",
    ...overrides,
  };
}

test("terminal ancestors cannot gain new work and parents cannot cancel active children", () => {
  const store = createCollaborationStore({ directory: fixture() });
  const parent = store.createTask(task({ id: "terminal-parent" }));
  const child = store.createTask(task({ id: "active-child", parentTaskId: parent.id }));
  assert.throws(() => store.record(parent.id, "cancelled"), /children/);
  store.record(child.id, "cancelled");
  store.record(parent.id, "cancelled");
  assert.throws(() => store.createTask(task({ parentTaskId: parent.id })), /terminal ancestor/);
  const done = store.createTask(task({ id: "passed-parent" }));
  store.record(done.id, "started");
  store.record(done.id, "returned", { summary: "complete" });
  store.record(done.id, "reviewed", { outcome: "passed", summary: "checked", evidence: [{ label: "test", path: "/synthetic/test" }] });
  assert.throws(() => store.createTask(task({ parentTaskId: done.id })), /terminal ancestor/);
});

test("existing shared directory permissions are preserved and private ledgers reject final symlinks", () => {
  const directory = fixture();
  fs.chmodSync(directory, 0o755);
  const store = createCollaborationStore({ directory });
  assert.throws(() => store.createTask(task()), /not private/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(directory, "collaboration-ledger.jsonl")), false);
  const alias = path.join(fixture(), "alias");
  fs.symlinkSync(directory, alias);
  assert.throws(() => createCollaborationStore({ directory: alias }), /symlink/);
});

test("macOS and Windows claims conservatively collide for missing paths differing only in case", { skip: !["darwin", "win32"].includes(process.platform) }, () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  const first = store.createTask(task({ permission: "write", writePaths: [path.join(directory, "Work", "result.txt")] }));
  const second = store.createTask(task({ permission: "write", writePaths: [path.join(directory, "work", "result.txt")] }));
  store.record(first.id, "started");
  assert.throws(() => store.record(second.id, "started"), /overlap/);
});

test("read-only opening returns an empty snapshot without creating local metadata", () => {
  const directory = path.join(fixture(), "not-created-yet");
  const store = createCollaborationStore({ directory });
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(store.snapshot().counts, { running: 0, awaitingReview: 0, blocked: 0, total: 0 });
  assert.equal(store.detail("missing"), null);
  assert.equal(fs.existsSync(directory), false);
});

test("collaboration store records reviewed task lifecycles and hides events from snapshots", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  const root = store.createTask(task({ id: "root" }));
  const child = store.createTask(task({ id: "child", parentTaskId: root.id, executor: "claude", permission: "patch", writePaths: [path.join(directory, "staged", "patch.js")] }));

  store.record(child.id, "started", { brief: "Run focused checks", command: "node -e \"console.log('$HOME; safe display')\"", timeoutSeconds: 90 });
  store.record(child.id, "returned", { summary: "Patch is ready", exitCode: 0, modelObserved: "claude-4", artifacts: [{ label: "Patch", path: "/tmp/patch.diff" }] });
  store.record(child.id, "reviewed", { outcome: "passed", summary: "Verified patch", evidence: [{ label: "Test", path: "/tmp/test.log" }] });
  store.record(root.id, "started");
  store.record(root.id, "returned", { summary: "Coordinator reviewed child", artifacts: [] });
  store.record(root.id, "reviewed", { outcome: "passed", summary: "Child and review are complete", evidence: [{ label: "Review", url: "https://example.test/review" }] });

  const snapshot = store.snapshot();
  assert.equal(snapshot.counts.total, 2);
  assert.equal(snapshot.counts.running, 0);
  assert.equal(snapshot.tasks.find((entry) => entry.id === root.id).status, "passed");
  assert.equal(Object.hasOwn(snapshot.tasks[0], "events"), false);
  assert.equal(snapshot.executors.find((entry) => entry.executor === "claude").running, 0);
  assert.equal(store.detail(child.id).modelObserved, "claude-4");
  assert.equal(store.detail(child.id).events.length, 3);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "collaboration-ledger.jsonl")).mode & 0o777, 0o600);
});

test("task validation rejects traversal, implicit writers, bad links, and passing a parent too early", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  assert.throws(() => store.createTask(task({ id: "../escape" })), /safe identifier/);
  assert.throws(() => store.createTask(task({ executor: "grok", permission: "write" })), /explicit writePaths/);
  const parent = store.createTask(task({ id: "parent" }));
  const child = store.createTask(task({ id: "child", parentTaskId: parent.id }));
  store.record(parent.id, "started");
  store.record(parent.id, "returned", { summary: "Review me", artifacts: [] });
  assert.throws(() => store.record(parent.id, "reviewed", { outcome: "passed", summary: "Looks good", evidence: [{ label: "proof", path: "/tmp/proof" }] }), /before each child/);
  assert.throws(() => store.record(child.id, "session_linked", { provider: "grok", sessionId: "unprefixed" }), /not canonical/);
  assert.throws(() => store.record(child.id, "reviewed", { outcome: "passed", summary: "", evidence: [] }), /required/);
});

test("starts are atomically bounded by external capacity and canonical overlapping write paths", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  const a = store.createTask(task({ id: "a", executor: "claude", permission: "patch", writePaths: [path.join(directory, "work")] }));
  const b = store.createTask(task({ id: "b", executor: "grok", permission: "patch", writePaths: [path.join(directory, "work", "one.js")] }));
  const c = store.createTask(task({ id: "c", executor: "antigravity", permission: "patch", writePaths: [path.join(directory, "third", "two.js")] }));
  store.record(a.id, "started");
  assert.throws(() => store.record(b.id, "started"), /overlap/);
  store.record(c.id, "started");
  const d = store.createTask(task({ id: "d", executor: "grok", permission: "patch", writePaths: [path.join(directory, "fourth", "three.js")] }));
  assert.throws(() => store.record(d.id, "started"), /external running limit/);
});

test("a competing ledger lock fails fast without removing another process lock", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  fs.mkdirSync(path.join(directory, ".collaboration-ledger.lock"));
  assert.throws(() => store.createTask(task({ id: "busy" })), /ledger is busy/);
  assert.equal(fs.existsSync(path.join(directory, ".collaboration-ledger.lock")), true);
  fs.rmdirSync(path.join(directory, ".collaboration-ledger.lock"));
  assert.equal(store.createTask(task({ id: "available" })).id, "available");
});

test("redacts structured and inline credentials before durable append", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  const item = store.createTask(task({ id: "secret-task", brief: "Authorization=very-secret Bearer abcdefghijkl \"api_key\":\"json-secret\" --api-key argument-secret sk-real-secret-token github_pat_real_secret_token" }));
  store.record(item.id, "started", { brief: "token=not-for-disk" });
  store.record(item.id, "blocked", { reason: "Failed", summary: "x".repeat(9000) });
  const disk = fs.readFileSync(path.join(directory, "collaboration-ledger.jsonl"), "utf8");
  assert.doesNotMatch(disk, /very-secret|abcdefghijkl|json-secret|argument-secret|real-secret-token|real_secret_token|not-for-disk/);
  assert.match(disk, /\[REDACTED\]/);
  assert.equal(redactText("api_key=secret-value"), "api_key=[REDACTED]");
  assert.match(store.detail(item.id).events.at(-1).payload.summary, /…$/);
});

test("rework remains explicit and malformed or incomplete ledger content fails closed", () => {
  const directory = fixture();
  const store = createCollaborationStore({ directory });
  const item = store.createTask(task({ id: "rework" }));
  store.record(item.id, "started");
  store.record(item.id, "returned", { summary: "Needs review", artifacts: [] });
  store.record(item.id, "reviewed", { outcome: "partial", summary: "One test missing", evidence: [] });
  store.record(item.id, "rework", { reason: "Add regression evidence" });
  assert.equal(store.detail(item.id).status, "rework");
  assert.equal(store.detail(item.id).attempt, 1);
  store.record(item.id, "started");
  assert.equal(store.detail(item.id).attempt, 2);

  const broken = fixture();
  fs.writeFileSync(path.join(broken, "collaboration-ledger.jsonl"), "{\"kind\":");
  assert.throws(() => createCollaborationStore({ directory: broken }), /truncated|incomplete/);
});
