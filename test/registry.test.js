import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRegistry } from "../lib/registry.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-registry-"));
}

function makeRegistry(file, opts = {}) {
  return createRegistry({
    file,
    key: (r) => r.id,
    reduce: (map, r) => {
      if (r.op === "remove") map.delete(r.id);
      else map.set(r.id, { ...r });
    },
    ...opts,
  });
}

test("registry replays records; last write wins", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ op: "upsert", id: "a", name: "first" }),
      JSON.stringify({ op: "upsert", id: "b", name: "second" }),
      JSON.stringify({ op: "upsert", id: "a", name: "updated" }),
    ].join("\n") + "\n",
  );
  const registry = makeRegistry(file);
  assert.equal(registry.size, 2);
  assert.equal(registry.get("a").name, "updated");
  assert.equal(registry.get("b").name, "second");
  registry.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry skips corrupt lines and counts them", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  const warnings = [];
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ op: "upsert", id: "a" }),
      "{not json",
      JSON.stringify({ op: "remove", id: "a" }),
      JSON.stringify({ op: "upsert", id: "x" }),
    ].join("\n") + "\n",
  );
  const registry = makeRegistry(file, {
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assert.equal(registry.size, 1);
  assert.equal(registry.has("x"), true);
  assert.equal(registry.stats.total, 4);
  assert.equal(registry.stats.skipped, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 2/);
  registry.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry appends with fsync and survives reload", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  const registry = makeRegistry(file, { now: () => "2026-01-01T00:00:00.000Z" });
  registry.append({ op: "upsert", id: "new", name: "created" });
  assert.equal(registry.get("new").ts, "2026-01-01T00:00:00.000Z");
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  registry.close();

  const reopened = makeRegistry(file);
  assert.equal(reopened.get("new").name, "created");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry append applies remove and batch writes all records", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  const registry = makeRegistry(file);
  registry.append({ op: "upsert", id: "a" });
  registry.appendBatch([
    { op: "upsert", id: "b" },
    { op: "remove", id: "a" },
  ]);
  assert.equal(registry.has("a"), false);
  assert.equal(registry.has("b"), true);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  registry.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry rolls back a failed write and keeps the file readable", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ op: "upsert", id: "ok" })}\n`);
  let calls = 0;
  const registry = makeRegistry(file, {
    writeSync: (...args) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a partial write that lands some bytes, then fails.
        fs.writeSync(args[0], args[1], 0, 3, args[4]);
        throw new Error("disk full");
      }
      return fs.writeSync(...args);
    },
  });
  assert.throws(() => registry.append({ op: "upsert", id: "bad" }), /disk full/);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.trim(), JSON.stringify({ op: "upsert", id: "ok" }));
  assert.equal(registry.has("bad"), false);
  assert.equal(registry.has("ok"), true);
  // The fd stays usable after rollback; a later append succeeds.
  registry.append({ op: "upsert", id: "later" });
  assert.equal(registry.has("later"), true);
  registry.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry seeds an empty file when seed records are provided", () => {
  const dir = tmp();
  const file = path.join(dir, "things.jsonl");
  const seed = [
    { op: "upsert", id: "seed1", name: "Seed One" },
    { op: "upsert", id: "seed2", name: "Seed Two" },
  ];
  const registry = makeRegistry(file, { seed: () => seed });
  assert.equal(registry.size, 2);
  assert.ok(fs.existsSync(file));
  registry.close();
  const reopened = makeRegistry(file, { seed: () => seed });
  assert.equal(reopened.size, 2);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
