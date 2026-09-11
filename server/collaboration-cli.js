#!/usr/bin/env node
// Explicit local producer for the read-only collaboration dashboard.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCollaborationStore, redactText } = require("./collaboration-store");
const { COLLABORATION_DIR } = require("./config");

const MAX_INPUT = 128 * 1024;
const MAX_CAPTURE = 64 * 1024;

function readText(file, limit = MAX_INPUT) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Input must be a regular file within the size limit");
  return fs.readFileSync(file, "utf8");
}

function parseOptions(args) {
  const options = {};
  const positional = [];
  let command = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--") { command = args.slice(i + 1); break; }
    if (!args[i].startsWith("--")) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!["input", "directory", "timeout", "brief-file", "result-file", "metadata-file"].includes(key)) throw new Error(`Unknown option: --${key}`);
    if (!args[i + 1] || args[i + 1].startsWith("--") || options[key] != null) throw new Error(`Expected one value for --${key}`);
    options[key] = args[++i];
  }
  return { positional, options, command };
}

function inputObject(options) {
  if (!options.input) throw new Error("Supply --input with a JSON file");
  let text;
  if (options.input === "-") {
    const chunks = [];
    let size = 0;
    const buffer = Buffer.alloc(8192);
    let count;
    while ((count = fs.readSync(0, buffer, 0, buffer.length, null)) > 0) {
      size += count;
      if (size > MAX_INPUT) throw new Error("JSON input exceeds size limit");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else text = readText(path.resolve(options.input));
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Input must be a JSON object");
  return data;
}

function failureCategory(message) {
  if (/\b401\b|oauth|unauthenticated|authentication|not logged in/i.test(message)) return "auth";
  if (/\b429\b|quota|rate.?limit|insufficient.*balance/i.test(message)) return "quota";
  if (/permission|denied|EACCES|EPERM/i.test(message)) return "permission";
  if (/ENOTFOUND|ECONN|network|fetch failed/i.test(message)) return "network";
  return "runtime";
}

function metadataFromFile(file, executor) {
  if (!file) return {};
  const data = JSON.parse(readText(file));
  // This schema is emitted by the existing no-tools Claude review wrapper.
  if (executor !== "claude" || data.auth_route !== "claude.ai subscription" || !Array.isArray(data.models)) return {};
  return {
    modelObserved: data.models.filter((model) => typeof model === "string").join(", "),
    sessionId: data.session_persisted === true && typeof data.session_id === "string" ? data.session_id : "",
  };
}

function executionEnvironment(taskId) {
  const environment = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    if (process.env[key] != null) environment[key] = process.env[key];
  }
  return { ...environment, OBSERVER_MANAGED_RUN: "1", OBSERVER_TASK_ID: taskId, OBSERVER_PARENT_TASK_ID: taskId };
}

async function runTask(store, id, options, command) {
  const task = store.detail(id);
  if (!task) throw new Error("Task not found");
  if (!command.length) throw new Error("run requires -- followed by an executable and its arguments");
  const timeoutSeconds = Number(options.timeout || 300);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error("timeout must be 1..3600 seconds");
  const cwd = task.cwd || process.cwd();
  if (!fs.statSync(cwd).isDirectory()) throw new Error("Task cwd is not a directory");
  const brief = options["brief-file"] ? readText(path.resolve(options["brief-file"])) : task.brief || "";
  store.record(id, "started", {
    brief,
    command: [path.basename(command[0]), ...command.slice(1)].join(" "),
    timeoutSeconds,
    recorderPid: process.pid,
  });

  let captured = "";
  let capturedBytes = 0;
  let captureTruncated = false;
  let stopReason = "";
  let spawnError = "";
  let killTimer;
  const child = spawn(command[0], command.slice(1), {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: executionEnvironment(id),
  });
  function capture(chunk) {
    const room = Math.max(0, MAX_CAPTURE - capturedBytes);
    const buffer = Buffer.from(chunk);
    captured += buffer.subarray(0, room).toString("utf8");
    capturedBytes += Math.min(room, buffer.length);
    if (buffer.length > room) captureTruncated = true;
  }
  function killGroup(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") spawnError ||= "Could not terminate child process";
    }
  }
  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 1500);
  }
  const onInterrupt = () => stop("cancelled");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.stdin.on("error", () => {}); // A short-lived executable may close stdin immediately.
  child.stdin.end(brief);
  child.on("error", (error) => { spawnError = error.code || "spawn failed"; });
  const result = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  // A parent can exit on SIGTERM while descendants keep running with closed pipes.
  if (stopReason) killGroup("SIGKILL");
  clearTimeout(killTimer);
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);

  let artifactError = "";
  const artifacts = [];
  let metadata = {};
  if (options["result-file"]) {
    try {
      const file = path.resolve(options["result-file"]);
      captured = readText(file, MAX_CAPTURE);
      captureTruncated = false;
      artifacts.push({ label: "执行结果", path: file });
    } catch {
      artifactError = "The declared result file could not be read within the size limit";
    }
  }
  if (options["metadata-file"]) {
    try { metadata = metadataFromFile(path.resolve(options["metadata-file"]), task.executor); }
    catch { artifactError ||= "The declared metadata file is unreadable or invalid"; }
  }
  const summary = redactText(captured || spawnError || (result.code === 0 ? "执行器返回，等待 Codex 独立验收。" : "执行器未正常返回。"))
    + (captureTruncated ? "\n[输出超过记录上限，已截断]" : "");
  if (stopReason === "cancelled") {
    store.record(id, "cancelled", { reason: "Recorder interrupted; child process terminated" });
    return { taskId: id, status: "cancelled", exitCode: 130 };
  }
  if (stopReason || spawnError || result.code !== 0 || artifactError) {
    const category = stopReason === "timeout" ? "timeout" : spawnError ? "tool" : result.code !== 0 ? failureCategory(captured) : "runtime";
    store.record(id, "blocked", { category, reason: stopReason || spawnError || (result.code !== 0 ? `Executable exited with ${result.code ?? result.signal}` : artifactError), summary });
    store.recordHealth({ executor: task.executor, status: "unknown", category, summary: `任务 ${id} 调用失败；这是任务输出分类，执行器可用性尚未独立核验。` });
    return { taskId: id, status: "blocked", exitCode: stopReason === "timeout" ? 124 : result.code || 1 };
  }
  if (metadata.sessionId) store.record(id, "session_linked", { provider: "claude", sessionId: metadata.sessionId });
  store.record(id, "returned", { summary, exitCode: result.code, artifacts, modelObserved: metadata.modelObserved || "" });
  store.recordHealth({ executor: task.executor, status: "unknown", category: "runtime", summary: `任务 ${id} 的程序已返回；执行器可用性和业务结果尚未独立核验。` });
  return { taskId: id, status: "awaiting_review", exitCode: 0 };
}

async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "help" || args[0] === "--help") {
    process.stdout.write("Usage: node server/collaboration-cli.js <create|event|health|list|show|run> [taskId] [eventType] [--input file.json] [--directory path]\nRun: run <taskId> [--timeout 300] [--brief-file file] [--result-file file] [--metadata-file file] -- executable arg...\nRead docs/collaboration.md for task/review schemas. Web API is read-only.\n");
    return;
  }
  const { positional, options, command } = parseOptions(args);
  const [action, id, type] = positional;
  const store = createCollaborationStore({ directory: options.directory || COLLABORATION_DIR });
  let result;
  switch (action) {
    case "create": result = store.createTask(inputObject(options)); break;
    case "event": result = store.record(id, type, inputObject(options)); break;
    case "health": result = store.recordHealth(inputObject(options)); break;
    case "list": result = store.snapshot(); break;
    case "show": result = store.detail(id); if (!result) throw new Error("Task not found"); break;
    case "run": result = await runTask(store, id, options, command); process.exitCode = result.exitCode; break;
    default: throw new Error("Unknown action; run with --help");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${redactText(error.message || "Recorder failed")}\n`);
    process.exitCode = 1;
  });
}
module.exports = { runTask, parseOptions, failureCategory };
