#!/usr/bin/env node
/**
 * Source file discovery helpers for session JSONL logs.
 */
const fs = require("fs");
const path = require("path");
const { providerSignature } = require("./provider-context");
const config = require("./config");
const fsScanner = require("./fs-scanner");
const { loadCustomSources } = require("./custom-sources");

function statFile(file) {
  const stat = fs.statSync(file);
  return {
    file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    signature: `${file}:${stat.size}:${stat.mtimeMs}:${providerSignature(file)}`,
  };
}

function listSourceFiles() {
  return [
    ...fsScanner.listJsonlFiles(config.SESSIONS_DIR),
    ...fsScanner.listJsonlFiles(config.CLAUDE_PROJECTS_DIR),
    ...fsScanner.listJsonlFiles(config.GROK_SESSIONS_DIR).filter((file) => ["chat_history.jsonl", "events.jsonl"].includes(path.basename(file))),
    ...[config.ANTIGRAVITY_BRAIN_DIR, config.ANTIGRAVITY_CLI_BRAIN_DIR].flatMap((directory) => (
      fsScanner.listJsonlFiles(directory).filter((file) => {
        if (path.basename(path.dirname(file)) !== "logs" || path.basename(path.dirname(path.dirname(file))) !== ".system_generated") return false;
        if (path.basename(file) === "transcript.jsonl") return true;
        return path.basename(file) === "transcript_full.jsonl" && !fs.existsSync(path.join(path.dirname(file), "transcript.jsonl"));
      })
    )),
    ...loadCustomSources().flatMap((source) => source.directories.flatMap((directory) => fsScanner.listJsonlFiles(directory))),
  ];
}

function listSourceFileRecords() {
  return listSourceFiles()
    .map((file) => {
      try {
        return statFile(file);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return String(right.file).localeCompare(String(left.file));
    });
}

function aggregateRecordsKey(records, prefix = "sources") {
  return `${prefix}|${(records || []).map((record) => record.signature).join("|")}`;
}

module.exports = {
  aggregateRecordsKey,
  listSourceFiles,
  listSourceFileRecords,
  statFile,
};
