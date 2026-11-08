import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createContextStore } from "../lib/contexts.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-contexts-"));
}

test("context records only ids and metadata, newest first", () => {
  const dir = tmp();
  const file = path.join(dir, "contexts.jsonl");
  const contexts = createContextStore({ file });
  contexts.append({ agent: "yao", group: "daily", trigger_message_id: 43, included_message_ids: [43], file_ids: ["f123"], reply_message_id: 44 });
  contexts.append({ agent: "yao", group: "daily", trigger_message_id: 45, included_message_ids: [45] });
  contexts.append({ agent: "xing", group: "daily", trigger_message_id: 46, included_message_ids: [46] });
  const list = contexts.list("yao");
  assert.equal(list.length, 2);
  assert.equal(list[0].context.trigger_message_id, 45);
  assert.deepEqual(list[1].context.file_ids, ["f123"]);
  assert.equal(list[0].context.reported_by, "yao");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.includes('"trigger_message_id"'));
  assert.ok(!raw.includes("prompt full text"));
  contexts.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("context validates agent and ids", () => {
  const dir = tmp();
  const file = path.join(dir, "contexts.jsonl");
  const contexts = createContextStore({ file });
  assert.throws(() => contexts.append({ agent: "BAD", trigger_message_id: 1 }), /invalid agent/);
  assert.throws(() => contexts.append({ agent: "yao", trigger_message_id: 0 }), /invalid trigger_message_id/);
  assert.throws(() => contexts.append({ agent: "yao", trigger_message_id: 1, included_message_ids: "x" }), /included_message_ids/);
  contexts.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("context survives reload and limits per agent", () => {
  const dir = tmp();
  const file = path.join(dir, "contexts.jsonl");
  const first = createContextStore({ file });
  for (let i = 1; i <= 5; i += 1) {
    first.append({ agent: "cc", trigger_message_id: i });
  }
  first.close();
  const second = createContextStore({ file });
  assert.equal(second.list("cc").length, 5);
  assert.equal(second.list("cc", 2).length, 2);
  assert.equal(second.list("cc", 2)[0].context.trigger_message_id, 5);
  assert.equal(second.list("unknown").length, 0);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
