import test from "node:test";
import assert from "node:assert/strict";

import {
  IDENTITY_RE, TOPIC_RE, FILE_ID_RE, GROUP_ID_RE, PLAN_ID_RE,
  MESSAGE_TYPES, shouldWakeMessage,
} from "../lib/protocol.js";

test("identity regex matches existing boundary rules", () => {
  assert.equal(IDENTITY_RE.test("cc"), true);
  assert.equal(IDENTITY_RE.test("dsh-sub1"), true);
  assert.equal(IDENTITY_RE.test("cc-"), false);
  assert.equal(IDENTITY_RE.test("CC"), false);
  assert.equal(IDENTITY_RE.test("cc中文"), false);
  assert.equal(IDENTITY_RE.test("cc2"), true);
  assert.equal(IDENTITY_RE.test(""), false);
});

test("topic, file, group, plan id patterns", () => {
  assert.equal(TOPIC_RE.test("ctf"), true);
  assert.equal(TOPIC_RE.test("bad topic"), false);
  assert.equal(FILE_ID_RE.test("f1a2b3c4d5e6"), true);
  assert.equal(GROUP_ID_RE.test("g-1a2b3c4d"), true);
  assert.equal(GROUP_ID_RE.test("dm-1a2b3c4d5e"), true);
  assert.equal(PLAN_ID_RE.test("p-1a2b3c4d"), true);
});

test("MESSAGE_TYPES includes plan", () => {
  for (const type of ["chat", "data", "sys", "file", "plan"]) {
    assert.equal(MESSAGE_TYPES.has(type), true);
  }
  assert.equal(MESSAGE_TYPES.has("notice"), false);
});

test("plan and data messages never wake; directed messages wake without @", () => {
  const base = { type: "chat", from: "youneiga", to: "all", body: "hello" };
  assert.equal(shouldWakeMessage({ ...base, type: "plan", body: '{"plan_id":"p-1"}' }, "xing"), false);
  assert.equal(shouldWakeMessage({ ...base, type: "data", body: "/tmp/x" }, "xing"), false);
  assert.equal(shouldWakeMessage(base, "xing"), false);
  assert.equal(shouldWakeMessage({ ...base, body: "@xing do it" }, "xing"), true);
  assert.equal(shouldWakeMessage({ ...base, to: "xing" }, "xing"), true);
  assert.equal(shouldWakeMessage({ ...base, body: "@all listen" }, "xing"), true);
  assert.equal(shouldWakeMessage({ ...base, from: "xing", body: "@xing self" }, "xing"), false);
  assert.equal(shouldWakeMessage({ ...base, body: "@xing2 no" }, "xing"), false);
  assert.equal(shouldWakeMessage({ ...base, body: "@CC no" }, "cc"), false);
});

test("operator follow-ups and listen window wake when enabled", () => {
  const base = { type: "chat", from: "yao", to: "all", body: "continue" };
  assert.equal(shouldWakeMessage(base, "xing"), false);
  assert.equal(shouldWakeMessage(base, "xing", { allowAgents: true, listenActive: true }), true);
  assert.equal(shouldWakeMessage({ ...base, body: "@youneiga follow up" }, "xing", { operator: "youneiga" }), true);
});
