// Keeps personal machine details out of the public repository.
// Only fails with a list of file paths — never prints the matched content.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PATH_PATTERNS = [
  /D:\\tool/i,
  /D:\/tool/i,
  /C:\\Users/i,
  /D:\\Project/i,
  /D:\/Project/i,
  /E:\\program/i,
  /192\.168\.221\./,
  /1482634100/,
];
const IDENTITY_PATTERN = /youneiga/;

// package.json legitimately carries the GitHub owner name in repository URLs.
const IDENTITY_EXEMPT_FILES = new Set(["package.json"]);

const SCAN_DIRS = ["lib", "clients", "public", "scripts", "docs", "bench", ".github"];
const SCAN_EXT = new Set([".js", ".mjs", ".json", ".md", ".html", ".css", ".cmd", ".ps1", ".vbs", ".sh", ".yml", ".yaml"]);
const ROOT_FILES = ["README.md", "README.zh-CN.md", "SECURITY.md", "CONTRIBUTING.md", "CLAUDE.md", "CHANGELOG.md", "LICENSE", ".gitignore", "package.json", "server.js", "claude-hooks.example.json"];

function* textFiles() {
  for (const rel of ROOT_FILES) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) yield rel;
  }
  function* walk(dir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Never follow data/, node_modules/, .git/, or results/ (benchmark
        // snapshots and local artifacts are not part of the source tree).
        if (["node_modules", "snapshots", "results", "data", ".git"].includes(entry.name)) continue;
        yield* walk(full, rel);
      } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name).toLowerCase())) {
        yield rel;
      }
    }
  }
  for (const dir of SCAN_DIRS) yield* walk(path.join(ROOT, dir), dir);
}

test("tracked source files contain no personal paths, usernames, or fixed LAN CIDR", () => {
  const offenders = [];
  for (const rel of textFiles()) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const hit =
      PATH_PATTERNS.some((re) => re.test(content)) ||
      (!IDENTITY_EXEMPT_FILES.has(path.basename(rel)) && IDENTITY_PATTERN.test(content));
    if (hit) offenders.push(rel.replaceAll("\\", "/"));
  }
  assert.deepEqual(offenders, [], `personal data found in: ${offenders.join(", ")}`);
});

test("the shared token value never appears in source files", () => {
  // The token file is local runtime data; if it is missing (CI / fresh clone),
  // there is nothing to compare against.
  let token = "";
  try {
    token = fs.readFileSync(path.join(ROOT, "data", "token.txt"), "utf8").trim();
  } catch {
    return;
  }
  if (!token) return;
  const offenders = [];
  for (const rel of textFiles()) {
    if (fs.readFileSync(path.join(ROOT, rel), "utf8").includes(token)) offenders.push(rel.replaceAll("\\", "/"));
  }
  assert.deepEqual(offenders, [], `token value leaked into: ${offenders.join(", ")}`);
});
