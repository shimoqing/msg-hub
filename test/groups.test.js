import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGroupRegistry, dmId } from "../lib/groups.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-groups-"));
}

test("groups seed legacy topics and mark them readable", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  assert.equal(groups.size, 4);
  assert.equal(groups.get("daily").name, "日常");
  assert.equal(groups.canRead("daily"), true);
  assert.equal(groups.canWrite("daily"), true);
  assert.equal(groups.canRead("unknown"), false);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("create group and dynamically allow its topic", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  const group = groups.create({ name: "登录页改造", members: ["youneiga", "xing", "yao"], created_by: "youneiga" });
  assert.match(group.id, /^g-[a-f0-9]{8}$/);
  assert.equal(groups.canRead(group.id), true);
  assert.equal(groups.canWrite(group.id), true);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archived group rejects writes but stays readable", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  const group = groups.create({ name: "旧群", members: ["youneiga", "cc"] });
  groups.update(group.id, { archived: true });
  assert.equal(groups.canRead(group.id), true);
  assert.equal(groups.canWrite(group.id), false);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DM id is deterministic and reuses an existing DM", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  const expected = dmId(["youneiga", "xing"]);
  const first = groups.create({ kind: "dm", members: ["youneiga", "xing"], created_by: "youneiga" });
  assert.equal(first.id, expected);
  const second = groups.create({ kind: "dm", members: ["xing", "youneiga"] });
  assert.equal(second.id, expected);
  assert.equal(groups.size, 5);
  const found = groups.findDm("youneiga", "xing");
  assert.equal(found.id, expected);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DM rejects a non-2 member list", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  assert.throws(() => groups.create({ kind: "dm", members: ["a", "b", "c"] }), /DM requires exactly 2/);
  assert.throws(() => groups.create({ kind: "dm", members: ["a"] }), /DM requires exactly 2/);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("groups reject invalid members, names, and reply modes", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const groups = createGroupRegistry({ file });
  assert.throws(() => groups.create({ name: "x", members: ["BAD ID"] }), /invalid member/);
  assert.throws(() => groups.create({ members: ["a"] }), /group name is required/);
  assert.throws(() => groups.create({ name: "x", members: ["a"], reply_mode: "bogus" }), /invalid reply_mode/);
  groups.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("group registry survives reload", () => {
  const dir = tmp();
  const file = path.join(dir, "groups.jsonl");
  const first = createGroupRegistry({ file });
  const group = first.create({ name: "持久群", members: ["youneiga", "cc"] });
  first.close();
  const second = createGroupRegistry({ file });
  assert.equal(second.get(group.id).name, "持久群");
  assert.deepEqual(second.get(group.id).members, ["youneiga", "cc"]);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
