#!/usr/bin/env node
// One-command first-run setup. Creates data/ and the shared token, checks the
// Node version, and prints the exact next commands. Never prints token values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureToken } from "../lib/auth.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(PROJECT_ROOT, "data");
const tokenFile = path.join(dataDir, "token.txt");

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

console.log("msg-hub setup\n");

const major = Number(process.versions.node.split(".")[0]);
check(`Node.js >= 24 (found ${process.versions.node})`, Number.isInteger(major) && major >= 24);

const hadToken = fs.existsSync(tokenFile);
try {
  ensureToken(tokenFile);
  check("token file", true, hadToken ? "existing token kept" : `generated at ${tokenFile}`);
} catch (err) {
  check("token file", false, err.message);
}

try {
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  check("data/ directories", true);
} catch (err) {
  check("data/ directories", false, err.message);
}

console.log(`
Defaults are loopback-only (127.0.0.1). If other machines on your LAN need
access, start the hub with:

  node server.js --host 0.0.0.0 --allow-lan

or set MSGHUB_ALLOWED_CIDRS to an explicit allowlist. The app-level CIDR
check is separate from any OS firewall rule.

Next steps:
  1. node server.js
  2. open http://127.0.0.1:18795/ (loopback injects the token automatically)
  3. docs/agents.md — connect a model or CLI agent
  4. node scripts/doctor.mjs — health check

The token lives at ${tokenFile} — never commit it, never paste its value.`);

if (checks.some((c) => !c.ok)) process.exitCode = 1;
