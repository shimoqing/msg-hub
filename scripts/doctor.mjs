#!/usr/bin/env node
// Read-only self-check. Prints paths and status only — never token values,
// chat bodies, or full log lines.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(PROJECT_ROOT, "data");
const tokenFile = path.join(dataDir, "token.txt");
const base = process.env.MSGHUB_BASE || "http://127.0.0.1:18795";

const results = [];
function report(label, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "  ok  " : " WARN "} ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("msg-hub doctor\n");

const major = Number(process.versions.node.split(".")[0]);
report(`Node.js >= 24`, Number.isInteger(major) && major >= 24, process.versions.node);
report("data/ exists", fs.existsSync(dataDir), dataDir);
report("token file exists (value not shown)", fs.existsSync(tokenFile), tokenFile);

const registryNames = ["agents", "groups", "plans", "profile", "contexts"];
for (const name of registryNames) {
  const file = path.join(dataDir, `${name}.jsonl`);
  const readable = !fs.existsSync(file) || (() => {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();
  report(`${name}.jsonl readable`, readable, readable ? "" : file);
}

async function health() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    report("hub /health", json.ok === true, `version ${json.version ?? "?"}, uptime ${Math.round(json.uptime_s ?? 0)}s, last_id ${json.last_id ?? "?"}`);
  } catch (err) {
    report("hub /health", false, err.message);
  }
}
await health();

const warned = results.filter((r) => !r).length;
console.log(`\n${results.length - warned}/${results.length} checks ok. Loopback is the default; for LAN access start with --host 0.0.0.0 --allow-lan (or MSGHUB_ALLOWED_CIDRS).`);
