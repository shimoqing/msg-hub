import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPlanRegistry } from "../lib/plans.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-plans-"));
}

function threeSteps() {
  return [
    { assignee: "xing", task: "先出方案" },
    { assignee: "yao", task: "按方案实现" },
    { assignee: "cc", task: "跑测试" },
  ];
}

function makePlan(file, overrides = {}) {
  const plans = createPlanRegistry({ file, ...overrides });
  const plan = plans.create({
    group: "daily",
    title: "登录页改造",
    created_by: "youneiga",
    steps: threeSteps(),
    card_message_id: 100,
  });
  plans.start(plan.plan_id);
  plans.markStepStart(plan.plan_id, 1, 120, 1);
  return { plans, plan };
}

test("plan create/start/step_start projection", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  assert.equal(plan.status, "running");
  assert.equal(plan.steps[0].status, "running");
  assert.equal(plan.steps[0].dispatch_message_id, 120);
  assert.equal(plans.summary(plan).current_step, 1);
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("observe accepts a genuine assignee reply and pauses", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  const hit = plans.observe({ id: 123, from: "xing", type: "chat", body: "done", reply_to: 120 });
  assert.equal(hit.done, true);
  assert.equal(plans.get(plan.plan_id).status, "paused");
  assert.equal(plans.get(plan.plan_id).steps[0].status, "done");
  assert.equal(plans.get(plan.plan_id).steps[0].reply_message_id, 123);
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("observe rejects a forged from, wrong reply_to, or late receipt", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  assert.equal(plans.observe({ id: 123, from: "yao", type: "chat", body: "forged", reply_to: 120 }), null);
  assert.equal(plans.observe({ id: 124, from: "xing", type: "chat", body: "wrong", reply_to: 999 }), null);
  plans.observe({ id: 123, from: "xing", type: "chat", body: "done", reply_to: 120 });
  assert.equal(plans.observe({ id: 125, from: "xing", type: "chat", body: "late", reply_to: 120 }), null);
  assert.equal(plans.get(plan.plan_id).status, "paused");
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file-only reply counts as completion and attaches the file id", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  const body = JSON.stringify({ id: "fabc", name: "plan.md", note: "方案" });
  const hit = plans.observe({ id: 123, from: "xing", type: "file", body, reply_to: 120 });
  assert.equal(hit.done, true);
  assert.deepEqual(plans.get(plan.plan_id).steps[0].file_ids, ["fabc"]);
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retry, stop, and final done", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  plans.fail(plan.plan_id, 1, "timeout");
  assert.equal(plans.get(plan.plan_id).status, "failed");
  plans.retry(plan.plan_id, 1);
  assert.equal(plans.get(plan.plan_id).status, "running");
  plans.markStepStart(plan.plan_id, 1, 121, 2);
  plans.observe({ id: 124, from: "xing", type: "chat", body: "ok", reply_to: 121 });
  assert.equal(plans.get(plan.plan_id).status, "paused");
  plans.markStepStart(plan.plan_id, 2, 125, 1);
  plans.observe({ id: 126, from: "yao", type: "chat", body: "ok", reply_to: 125 });
  plans.markStepStart(plan.plan_id, 3, 127, 1);
  plans.observe({ id: 128, from: "cc", type: "chat", body: "ok", reply_to: 127 });
  assert.equal(plans.get(plan.plan_id).status, "done");
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stop prevents later receipts from completing a step", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file);
  plans.stop(plan.plan_id);
  assert.equal(plans.get(plan.plan_id).status, "stopped");
  assert.equal(plans.observe({ id: 123, from: "xing", type: "chat", body: "late", reply_to: 120 }), null);
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweep marks timed-out steps failed without redispatching", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const { plans, plan } = makePlan(file, { timeoutMs: 0 });
  // force an expired deadline
  const current = plans.get(plan.plan_id);
  current.steps[0].deadline_ts = new Date(Date.now() - 1000).toISOString();
  const expired = plans.sweep();
  assert.equal(expired.length, 1);
  assert.equal(plans.get(plan.plan_id).status, "failed");
  assert.equal(plans.get(plan.plan_id).steps[0].error, "timeout");
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plan validates title, steps, assignees, and max 6 steps", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const plans = createPlanRegistry({ file });
  assert.throws(() => plans.create({ group: "daily", title: "", steps: threeSteps() }), /invalid title/);
  assert.throws(() => plans.create({ group: "daily", title: "x", steps: [] }), /steps must be/);
  assert.throws(() => plans.create({ group: "daily", title: "x", steps: Array(7).fill(threeSteps()[0]) }), /steps must be/);
  assert.throws(() => plans.create({ group: "daily", title: "x", steps: [{ assignee: "BAD", task: "x" }] }), /invalid assignee/);
  assert.throws(() => plans.create({ group: "daily", title: "x", steps: [{ assignee: "cc", task: "" }] }), /invalid task/);
  plans.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plan registry survives reload", () => {
  const dir = tmp();
  const file = path.join(dir, "plans.jsonl");
  const first = createPlanRegistry({ file });
  const plan = first.create({ group: "daily", title: "持久分工", created_by: "youneiga", steps: threeSteps() });
  first.start(plan.plan_id);
  first.close();
  const second = createPlanRegistry({ file });
  assert.equal(second.get(plan.plan_id).status, "running");
  assert.equal(second.get(plan.plan_id).steps.length, 3);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
