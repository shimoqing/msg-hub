import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../lib/log.js";

test("logger splits files when maxBytes is exceeded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-log-"));
  const now = new Date(2026, 10, 5, 10, 0, 0, 0);
  const logger = createLogger({
    logDir: dir,
    maxBytes: 50,
    now: () => now,
    prefix: "hub",
  });
  try {
    logger.info("first line padding padding");
    logger.info("second line padding padding");
    logger.info("third line padding padding");
  } finally {
    logger.close();
  }
  try {
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.length >= 2, `expected rotation, got ${files.join(", ")}`);
    const text = files.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("");
    assert.match(text, /first line/);
    assert.match(text, /second line/);
    assert.match(text, /third line/);
    for (const name of files) {
      assert.match(name, /^hub-2026-11-05/);
      assert.match(fs.readFileSync(path.join(dir, name), "utf8"), /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
