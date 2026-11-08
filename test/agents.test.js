import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAgentRegistry } from "../lib/agents.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-agents-"));
}

test("self-registration records backend/model/capabilities without touching manual profile", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const agents = createAgentRegistry({ file });
  agents.upsert({ id: "xing", name: "Xing", role: "资料核查", avatar_hue: 18 });
  agents.observe({ id: "xing", backend: "openclaw", model: "GLM-5.3", capabilities: ["files", "tasks"] });
  const xing = agents.get("xing");
  assert.equal(xing.name, "Xing");
  assert.equal(xing.role, "资料核查");
  assert.equal(xing.backend, "openclaw");
  assert.equal(xing.model, "GLM-5.3");
  assert.deepEqual(xing.capabilities, ["files", "tasks"]);
  assert.equal(xing.source, "manual");
  agents.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("manual upsert does not clear observed backend/model", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const agents = createAgentRegistry({ file });
  agents.observe({ id: "yao", backend: "claude", model: "sonnet", capabilities: ["files"] });
  agents.upsert({ id: "yao", name: "姚", role: "实现" });
  const yao = agents.get("yao");
  assert.equal(yao.name, "姚");
  assert.equal(yao.backend, "claude");
  assert.equal(yao.model, "sonnet");
  agents.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agents registry validates id, capabilities, and launch mode", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const agents = createAgentRegistry({ file });
  assert.throws(() => agents.observe({ id: "BAD", backend: "claude" }), /invalid agent id/);
  assert.throws(() => agents.upsert({ id: "cc", capabilities: ["bogus"] }), /invalid capability/);
  assert.throws(() => agents.upsert({ id: "cc", launch: { mode: "shell" } }), /invalid launch.mode/);
  assert.throws(() => agents.upsert({ id: "cc", name: "x".repeat(40) }), /invalid name/);
  agents.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agents registry accepts the universal backends and still rejects unknown ones", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const agents = createAgentRegistry({ file });
  for (const backend of ["openai", "anthropic", "command"]) {
    agents.observe({ id: `w-${backend}`, backend, model: "m" });
    assert.equal(agents.get(`w-${backend}`)?.backend, backend);
  }
  assert.throws(() => agents.observe({ id: "w-x", backend: "grok" }), /invalid backend/);
  agents.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("remove deletes the agent but history in chat is unaffected", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const agents = createAgentRegistry({ file });
  agents.upsert({ id: "cc" });
  assert.equal(agents.has("cc"), true);
  agents.remove("cc");
  assert.equal(agents.has("cc"), false);
  agents.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent registry survives reload and seeds known identities only when empty", () => {
  const dir = tmp();
  const file = path.join(dir, "agents.jsonl");
  const seed = [{ id: "cc", name: "Claude Code" }, { id: "dsh", name: "Kali dsh" }];
  const first = createAgentRegistry({ file, seed });
  assert.equal(first.size, 2);
  first.close();
  const second = createAgentRegistry({ file, seed });
  assert.equal(second.size, 2);
  assert.equal(second.get("cc").name, "Claude Code");
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
