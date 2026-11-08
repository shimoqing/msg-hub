import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLauncher } from "../lib/launcher.js";

const FAKE_WATCHER = fileURLToPath(new URL("./fixtures/fake-watcher.js", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-launcher-"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launcherOpts(dir, overrides = {}) {
  const tokenFile = path.join(dir, "token.txt");
  fs.writeFileSync(tokenFile, "test-token\n", { mode: 0o600 });
  return {
    dataDir: path.join(dir, "data"),
    tokenFile,
    base: "http://127.0.0.1:18795",
    nodeBin: process.execPath,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

test("launcher rejects non-loopback, unknown ids, and non-local presets", () => {
  const dir = tmp();
  const launcher = createLauncher(launcherOpts(dir));
  assert.throws(() => launcher.start("BAD"), /invalid agent id/);
  assert.throws(() => launcher.start("nosuchagent"), /no built-in local preset/);
  assert.throws(() => launcher.start("watcher-openclaw", { loopback: false }), /requires loopback/);
  launcher.stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("launcher starts a preset process, blocks a duplicate, and stops it", async () => {
  const dir = tmp();
  const launcher = createLauncher(launcherOpts(dir));
  // Swap in the fake watcher for the local preset's args so the test never
  // spawns a real model CLI.
  const presets = await import("../lib/presets.js");
  const original = presets.getPreset("watcher-openclaw").args;
  presets.getPreset("watcher-openclaw").args = [FAKE_WATCHER];
  try {
    const started = launcher.start("watcher-openclaw");
    assert.equal(started.state, "starting");
    assert.ok(Number.isInteger(started.pid));
    assert.ok(started.log_path.endsWith("console.log"));
    assert.throws(() => launcher.start("watcher-openclaw"), /already has/);
    await sleep(200);
    const status = launcher.status("watcher-openclaw");
    assert.equal(status.state, "online");
    assert.equal(status.started_by, "hub");
    const stopped = launcher.stop("watcher-openclaw");
    assert.equal(stopped.state, "stopping");
    await sleep(200);
    assert.equal(launcher.status("watcher-openclaw"), null);
    assert.equal(launcher.size, 0);
  } finally {
    presets.getPreset("watcher-openclaw").args = original;
    launcher.stopAll();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher stopAll kills every Hub-started process", async () => {
  const dir = tmp();
  const launcher = createLauncher(launcherOpts(dir));
  const presets = await import("../lib/presets.js");
  const originalA = presets.getPreset("watcher-openclaw").args;
  const originalB = presets.getPreset("watcher-claude").args;
  presets.getPreset("watcher-openclaw").args = [FAKE_WATCHER];
  presets.getPreset("watcher-claude").args = [FAKE_WATCHER];
  try {
    launcher.start("watcher-openclaw");
    launcher.start("watcher-claude");
    assert.equal(launcher.size, 2);
    launcher.stopAll();
    await sleep(200);
    assert.equal(launcher.size, 0);
  } finally {
    presets.getPreset("watcher-openclaw").args = originalA;
    presets.getPreset("watcher-claude").args = originalB;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher logs only path and pid/exit metadata", () => {
  const dir = tmp();
  const messages = [];
  const launcher = createLauncher(launcherOpts(dir, {
    logger: { info: (m) => messages.push(m), warn() {}, error: (m) => messages.push(m) },
  }));
  assert.throws(() => launcher.start("nosuchagent"), /no built-in local preset/);
  assert.equal(messages.length, 0);
  launcher.stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
});
