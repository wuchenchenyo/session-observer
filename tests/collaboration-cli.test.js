const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createCollaborationStore } = require("../server/collaboration-store");

const cli = path.join(__dirname, "../server/collaboration-cli.js");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-recorder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "ledger");
  return { root, directory, store: createCollaborationStore({ directory }) };
}
function invoke(f, args, input) {
  return spawnSync(process.execPath, [cli, ...args, "--directory", f.directory], { encoding: "utf8", input, timeout: 10000 });
}
function create(f, executor, parentTaskId) {
  const result = invoke(f, ["create", "--input", "-"], JSON.stringify({
    title: `${executor} synthetic task`, executor, permission: "read-only", cwd: f.root,
    brief: "Review the synthetic sample", ...(parentTaskId ? { parentTaskId } : {}),
  }));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function run(f, id, script, options = []) {
  const file = path.join(f.root, `${id}.cjs`);
  fs.writeFileSync(file, script);
  return spawnSync(process.execPath, [cli, "run", id, "--directory", f.directory, ...options, "--", process.execPath, file], { encoding: "utf8", timeout: 12000 });
}

test("recorder CLI links tasks and preserves the return, rework and independent acceptance cycle", (t) => {
  const f = fixture(t);
  const root = create(f, "codex");
  const child = create(f, "grok", root.id);
  assert.equal(child.rootTaskId, root.id);
  let result = run(f, child.id, "process.stdout.write('Synthetic proposal');");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.store.detail(child.id).status, "awaiting_review");
  f.store.record(child.id, "rework", { reason: "Add the missing boundary case" });
  result = run(f, child.id, "process.stdout.write('Synthetic revised proposal');");
  assert.equal(result.status, 0, result.stderr);
  f.store.record(child.id, "session_linked", { provider: "grok", sessionId: "grok:synthetic-child" });
  f.store.record(child.id, "reviewed", { outcome: "passed", summary: "Independent synthetic checks passed", evidence: [{ label: "test evidence", path: path.join(f.root, `${child.id}.cjs`) }] });
  const complete = f.store.detail(child.id);
  assert.equal(complete.attempt, 2);
  assert.equal(complete.status, "passed");
  assert.deepEqual(complete.events.map((event) => event.type), ["started", "returned", "rework", "started", "returned", "session_linked", "reviewed"]);
  assert.equal(f.store.snapshot().executors.find((item) => item.executor === "grok").status, "unknown");
});

test("recorder persists sanitized stdin and output, and never treats a failed subprocess as accepted", (t) => {
  const f = fixture(t);
  const task = create(f, "claude");
  const briefFile = path.join(f.root, "brief.txt");
  fs.writeFileSync(briefFile, 'Use sample. api_key="SYNTHETIC_PRIVATE_KEY"');
  const result = run(f, task.id, "process.stdin.resume(); process.stdin.on('end', () => { console.error('OAuth 401 password=private_fixture_value'); process.exitCode=1; });", ["--brief-file", briefFile]);
  assert.equal(result.status, 1, result.stderr);
  const detail = f.store.detail(task.id);
  assert.equal(detail.status, "blocked");
  assert.equal(detail.events.at(-1).payload.category, "auth");
  const ledger = fs.readFileSync(path.join(f.directory, "collaboration-ledger.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /SYNTHETIC_PRIVATE_KEY|private_fixture_value/);
  assert.match(ledger, /REDACTED/);
});

test("recorder timeout stops the subprocess and records a distinct blocked reason", (t) => {
  const f = fixture(t);
  const task = create(f, "antigravity");
  const result = run(f, task.id, "setInterval(() => {}, 1000);", ["--timeout", "1"]);
  assert.equal(result.status, 124, result.stderr);
  const detail = f.store.detail(task.id);
  assert.equal(detail.status, "blocked");
  assert.equal(detail.events.at(-1).payload.category, "timeout");
  assert.equal(f.store.snapshot().counts.running, 0);
});

test("timeout also stops descendants when their parent exits before the grace period", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const task = create(f, "grok");
  const pidFile = path.join(f.root, "descendant.pid");
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const result = run(f, task.id, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`, ["--timeout", "1"]);
  assert.equal(result.status, 124, result.stderr);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ } });
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, "descendant must not retain a released write claim");
});

test("simultaneous recorder processes cannot overbook the external limit or corrupt the ledger", async (t) => {
  const f = fixture(t);
  const tasks = ["grok", "claude", "antigravity"].map((executor) => create(f, executor));
  const results = await Promise.all(tasks.map((task) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "event", task.id, "started", "--input", "-", "--directory", f.directory], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.stdin.end(JSON.stringify({ command: "synthetic held task" }));
    child.on("close", (code) => resolve({ code, stderr }));
  })));
  const started = results.filter((result) => result.code === 0).length;
  assert.ok(started >= 1 && started <= 2);
  for (const result of results.filter((result) => result.code !== 0)) assert.match(result.stderr, /busy|limit/);
  assert.equal(f.store.snapshot().counts.running, started);
  assert.equal(fs.existsSync(path.join(f.directory, ".collaboration-ledger.lock")), false);
});

test("no-session Claude result files and metadata are captured without a transcript directory", (t) => {
  const f = fixture(t);
  const task = create(f, "claude");
  const output = path.join(f.root, "review.txt");
  const meta = path.join(f.root, "review.meta.json");
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(output)},'Synthetic checked answer');fs.writeFileSync(${JSON.stringify(meta)},JSON.stringify({auth_route:'claude.ai subscription',session_id:'synthetic-claude',models:['recorded-model-id']}));`;
  const result = run(f, task.id, script, ["--result-file", output, "--metadata-file", meta]);
  assert.equal(result.status, 0, result.stderr);
  const detail = f.store.detail(task.id);
  assert.equal(detail.status, "awaiting_review");
  assert.equal(detail.modelObserved, "recorded-model-id");
  assert.equal(detail.sessions.length, 0, "no persisted session means no clickable session link");
  assert.equal(detail.events.at(-1).payload.summary, "Synthetic checked answer");
});

test("runner obeys the shared external concurrency limit before executing a third program", async (t) => {
  const f = fixture(t);
  for (const executor of ["grok", "claude"]) {
    const task = create(f, executor);
    f.store.record(task.id, "started", { command: "synthetic held task" });
  }
  const third = create(f, "antigravity");
  const marker = path.join(f.root, "must-not-exist");
  const result = run(f, third.id, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /limit/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(f.store.detail(third.id).status, "queued");
});

test("runner does not forward unrelated environment credentials to the executable", (t) => {
  const f = fixture(t);
  const task = create(f, "grok");
  const prior = process.env.OBSERVER_TEST_PRIVATE_TOKEN;
  process.env.OBSERVER_TEST_PRIVATE_TOKEN = "synthetic_environment_secret";
  try {
    const result = run(f, task.id, "if(process.env.OBSERVER_TEST_PRIVATE_TOKEN) process.exit(42); console.log('minimal environment');");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.store.snapshot().executors.find((item) => item.executor === "grok").status, "unknown");
  } finally {
    if (prior === undefined) delete process.env.OBSERVER_TEST_PRIVATE_TOKEN;
    else process.env.OBSERVER_TEST_PRIVATE_TOKEN = prior;
  }
});

test("portable Claude adapter records a no-session review via a local fake executable", (t) => {
  const f = fixture(t);
  const python = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(python.status, 0);
  const binary = path.join(f.root, "bin");
  fs.mkdirSync(binary);
  fs.writeFileSync(path.join(binary, "claude"), `#!${python.stdout.trim()}\nimport sys,json\nif sys.argv[1:3] == ['auth','status']:\n print(json.dumps({'loggedIn':True,'authMethod':'claude.ai','subscriptionType':'pro'}))\nelse:\n assert '--no-session-persistence' in sys.argv\n assert '--safe-mode' in sys.argv\n text=sys.stdin.read()\n print(json.dumps({'result':'Checked synthetic brief','is_error':False,'modelUsage':{'synthetic-model':{}},'session_id':'synthetic-no-session'}))\n`, { mode: 0o700 });
  const brief = path.join(f.root, "brief.txt");
  fs.writeFileSync(brief, "Synthetic approved brief");
  const parent = create(f, "codex");
  const environment = { ...process.env, PATH: `${binary}${path.delimiter}${process.env.PATH}` };
  for (const key of ["OBSERVER_MANAGED_RUN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete environment[key];
  const result = spawnSync(python.stdout.trim(), [path.join(__dirname, "../examples/claude-review.py"), "--brief", brief, "--out", path.join(f.root, "answer.txt"), "--observer-parent", parent.id, "--observer-directory", f.directory], { encoding: "utf8", env: environment, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const tasks = f.store.snapshot().tasks;
  assert.equal(tasks.length, 2, "managed child must not recursively register another task");
  const child = tasks.find((item) => item.parentTaskId === parent.id);
  assert.equal(child.status, "awaiting_review");
  assert.equal(child.modelObserved, "synthetic-model");
  assert.equal(child.sessions.length, 0);
  assert.equal(f.store.detail(child.id).events.at(-1).payload.summary, "Checked synthetic brief");
});
