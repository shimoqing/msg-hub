import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireWatcherLock,
  allMentionRegex,
  buildPrompt,
  buildReplyBody,
  childEnv,
  claudeArgs,
  claudeReplyText,
  extractClaudeResult,
  extractEnvelope,
  extractReplyText,
  makeTurnGuard,
  mentionRegex,
  openClawArgs,
  parseHop,
  safeLastId,
  shouldWake,
} from "../clients/responder.js";

test("mentionRegex matches @xing at word boundaries", () => {
  const re = mentionRegex("xing");
  assert.ok(re.test("@xing 你好"));
  assert.ok(re.test("hi @xing!"));
  assert.ok(re.test("@xing中文 命中"));
  assert.ok(re.test("@xing，"));
  assert.ok(!re.test("@xing- 后缀"));
  assert.ok(!re.test("@xing2 不降级"));
  assert.ok(!re.test("mail@xing 拼接"));
  assert.ok(!re.test("@Xing 大写"));
});

test("allMentionRegex matches @all only at boundaries", () => {
  const re = allMentionRegex();
  assert.ok(re.test("@all 集合"));
  assert.ok(re.test("text @all."));
  assert.ok(!re.test("@allhands"));
});

test("parseHop reads the largest [hop:N] marker", () => {
  assert.equal(parseHop("no marker"), 0);
  assert.equal(parseHop("[hop:2] done"), 2);
  assert.equal(parseHop("[hop:0]"), 0);
  assert.equal(parseHop("[hop:1] then [hop:3]"), 3);
  assert.equal(parseHop("[hop:x]"), 0);
});

const BASE = { id: 12, from: "youneiga", to: "all", topic: "daily", type: "chat", body: "@xing 在吗", reply_to: null };

test("shouldWake: operator mention wakes, data/plan/self/no-mention do not", () => {
  const opts = { identity: "xing", operator: "youneiga", allowAgents: false };
  assert.equal(shouldWake(BASE, opts), true);
  assert.equal(shouldWake({ ...BASE, type: "data" }, opts), false);
  assert.equal(shouldWake({ ...BASE, type: "plan", body: '{"plan_id":"p-1a2b3c4d"}' }, opts), false);
  assert.equal(shouldWake({ ...BASE, from: "xing" }, opts), false);
  assert.equal(shouldWake({ ...BASE, body: "没有提及" }, opts), false);
  assert.equal(shouldWake({ ...BASE, body: "@yao 找别人" }, opts), false);
  assert.equal(shouldWake({ ...BASE, body: "@all 大家好" }, opts), true);
  assert.equal(shouldWake({ ...BASE, to: "xing", body: "定向但无 @" }, opts), true);
});

test("shouldWake: other agents only with allowAgents and under the hop cap", () => {
  const opts = { identity: "xing", operator: "youneiga", allowAgents: false };
  assert.equal(shouldWake({ ...BASE, from: "yao" }, opts), false);
  const agentOpts = { ...opts, allowAgents: true };
  assert.equal(shouldWake({ ...BASE, from: "yao" }, agentOpts), true);
  assert.equal(shouldWake({ ...BASE, from: "yao", body: "@xing 看 [hop:1]" }, agentOpts), true);
  assert.equal(shouldWake({ ...BASE, from: "yao", body: "@xing 看 [hop:2]" }, agentOpts), false);
  assert.equal(shouldWake({ ...BASE, from: "yao", type: "data" }, agentOpts), false);
});

test("shouldWake: listen window wakes peer follow-ups without a mention", () => {
  const active = { peer: "youneiga", until: 1_000, now: 500 };
  const opts = { identity: "xing", operator: "youneiga", allowAgents: false, listen: active };
  assert.equal(shouldWake({ ...BASE, body: "没有提及的追问" }, opts), true);
  assert.equal(
    shouldWake({ ...BASE, body: "没有提及的追问" }, { ...opts, listen: { ...active, now: 1_001 } }),
    false,
  );
  assert.equal(shouldWake({ ...BASE, body: "没有提及的追问", from: "yao" }, opts), false);
  assert.equal(shouldWake({ ...BASE, type: "data" }, opts), false);
});

test("buildPrompt wraps the message as untrusted JSON data", () => {
  const prompt = buildPrompt({ message: BASE, identity: "xing", displayName: "Xing" });
  assert.ok(prompt.includes("--- BEGIN MESSAGE JSON ---"));
  assert.ok(prompt.includes(JSON.stringify(BASE)));
  assert.ok(prompt.includes("Do not use any tools"));
  assert.ok(prompt.includes("@youneiga"));
  assert.ok(prompt.includes("Xing"));
});

const SAMPLE_OUTPUT = [
  "\x1b[35m[plugins]\x1b[39m log line { with brace",
  "\x1b[33m[agents]\x1b[39m run ended",
  "{",
  '  "ok": true,',
  '  "final": "@youneiga MHX-123",',
  '  "payloads": [{ "text": "@youneiga MHX-123", "mediaUrl": null }],',
  '  "bridgeCalls": { "search": 0, "describe": 0, "call": 0 },',
  '  "note": "close brace in string } stays inside"',
  "}",
  "[state] clean-close receipt: written",
].join("\n");

test("extractEnvelope parses the JSON envelope out of noisy CLI output", () => {
  const env = extractEnvelope(SAMPLE_OUTPUT);
  assert.equal(env.ok, true);
  assert.equal(env.final, "@youneiga MHX-123");
  assert.deepEqual(env.bridgeCalls, { search: 0, describe: 0, call: 0 });
});

test("extractEnvelope accepts pure JSON and rejects garbage", () => {
  assert.deepEqual(extractEnvelope('{"ok":true}'), { ok: true });
  assert.throws(() => extractEnvelope("no json here"));
  assert.throws(() => extractEnvelope(""));
});

test("extractReplyText accepts documented shapes and rejects empty", () => {
  assert.equal(extractReplyText({ final: "a" }), "a");
  assert.equal(extractReplyText({ payloads: [{ text: "b" }] }), "b");
  assert.equal(extractReplyText({ result: { final: "c" } }), "c");
  assert.equal(extractReplyText({ result: { payloads: [{ text: "d" }] } }), "d");
  assert.equal(extractReplyText({ text: "e" }), "e");
  assert.throws(() => extractReplyText({}));
  assert.throws(() => extractReplyText({ final: "   " }));
});

test("openClawArgs pins node entry, state dir, timeout and lean tools", () => {
  const args = openClawArgs({
    promptFile: "p.txt",
    cwd: "w",
    stateDir: "s",
    timeoutSec: 150,
    nodeEntry: "openclaw.mjs",
    config: "cfg.json",
  });
  assert.equal(args[0], "openclaw.mjs");
  assert.ok(args.includes("agent"));
  assert.ok(args.includes("exec"));
  assert.deepEqual(
    [
      "--message-file",
      "p.txt",
      "--json",
      "--config",
      "cfg.json",
      "--cwd",
      "w",
      "--state-dir",
      "s",
      "--timeout",
      "150",
      "--local-model-lean",
    ].every((v) => args.includes(v)),
    true,
  );
  assert.equal(args.includes("--model"), false);
});

test("buildReplyBody truncates text before appending the hop marker", () => {
  const short = buildReplyBody({ text: "你好", from: "youneiga" });
  assert.equal(short, "@youneiga 你好");

  const mentioned = buildReplyBody({ text: "@youneiga 已带上提及", from: "youneiga" });
  assert.equal(mentioned, "@youneiga 已带上提及");

  // >4000 chars from an agent: marker must survive truncation.
  const long = "啊".repeat(4500);
  const body = buildReplyBody({ text: long, from: "yao", agentOrigin: true, nextHop: 1 });
  assert.ok(body.length <= 4000 + 10, `body length ${body.length}`);
  assert.ok(body.startsWith("@yao "));
  assert.ok(body.endsWith("[hop:1]"));
  assert.equal(parseHop(body), 1);

  const plain = buildReplyBody({ text: long, from: "youneiga" });
  assert.ok(plain.length <= 4000);
  assert.ok(!plain.includes("[hop:"));
});

test("childEnv allowlist drops secrets and honors extras", () => {
  process.env.MSGHUB_TOKEN = "secret-token-for-test";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-for-test";
  const env = childEnv({ NODE_OPTIONS: "" });
  assert.equal(env.MSGHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, "");
  assert.ok(env.SystemRoot || env.windir || env.SystemDrive);
  delete process.env.MSGHUB_TOKEN;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

test("openClawArgs passes an explicit --model when configured", () => {
  const args = openClawArgs({
    promptFile: "p.txt",
    cwd: "w",
    stateDir: "s",
    timeoutSec: 90,
    nodeEntry: "openclaw.mjs",
    model: "magpie/workbuddy/deepseek-v4.1-flash",
  });
  const i = args.indexOf("--model");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "magpie/workbuddy/deepseek-v4.1-flash");
});

test("claudeArgs pins tool-free, restricted, non-persistent execution", () => {
  const args = claudeArgs();
  const required = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--max-budget-usd",
  ];
  for (const flag of required) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args.includes("--model"), false);

  const withModel = claudeArgs({ model: "workbuddy/deepseek-v4.1-flash" });
  const i = withModel.indexOf("--model");
  assert.ok(i > 0);
  assert.equal(withModel[i + 1], "workbuddy/deepseek-v4.1-flash");
});

test("extractClaudeResult finds the result line after CLI warnings", () => {
  const raw = [
    "[claude-code:unrecognized_model] {\"model\":\"x\"}",
    '{"type":"system","subtype":"init"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"YAO_OK","permission_denials":[]}',
  ].join("\n");
  const result = extractClaudeResult(raw);
  assert.equal(result.result, "YAO_OK");
  assert.equal(claudeReplyText(result), "YAO_OK");
  assert.throws(() => extractClaudeResult("no json"));
});

test("claudeReplyText rejects errors, denials and empty output", () => {
  assert.equal(claudeReplyText({ subtype: "success", result: "ok" }), "ok");
  assert.throws(() => claudeReplyText({ is_error: true, result: "x" }));
  assert.throws(() => claudeReplyText({ subtype: "error_max_turns", result: "x" }));
  assert.throws(() => claudeReplyText({ subtype: "success", result: "x", permission_denials: [{}] }));
  assert.throws(() => claudeReplyText({ subtype: "success", result: "   " }));
});

test("safeLastId advances only over received messages", () => {
  assert.equal(safeLastId([]), null);
  assert.equal(safeLastId([{ id: 3 }, { id: 9 }, { id: 5 }]), 9);
});

test("makeTurnGuard: wrapSettle settles exactly once and stops the timers", async () => {
  const fakeChild = { kill() {} };
  const guard = makeTurnGuard({ child: fakeChild, killMs: 30_000, settleMs: 60_000, label: "test" });
  const seen = [];
  const settle = guard.wrapSettle((code) => seen.push(code));

  settle(0);
  settle(1); // second close event must be a no-op
  assert.deepEqual(seen, [0]);
  assert.equal(guard.state.settled, true);

  // Timers were cleared by finish(): neither the kill nor the forced settle fires.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(guard.state.hardTimed, false);
});

test("makeTurnGuard: kill timer hard-kills a hung child", async () => {
  let kills = 0;
  const fakeChild = { kill() { kills += 1; } };
  const guard = makeTurnGuard({ child: fakeChild, killMs: 30, settleMs: 30_000, label: "test" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(guard.state.hardTimed, true);
  assert.ok(kills >= 1);
  guard.finish();
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "responder-test-"));
}

test("acquireWatcherLock: exclusive while holder alive, reclaims dead/corrupt", async () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, "w.lock");

  const first = acquireWatcherLock(lockPath, { holderPid: process.pid });
  assert.equal(first.pid, process.pid);
  assert.throws(() => acquireWatcherLock(lockPath, { holderPid: process.pid }));
  first.release();
  assert.equal(fs.existsSync(lockPath), false);

  const again = acquireWatcherLock(lockPath, { holderPid: process.pid });
  again.release();

  fs.writeFileSync(lockPath, "not json\n", "utf8");
  const reclaimed = acquireWatcherLock(lockPath, { holderPid: process.pid });
  reclaimed.release();

  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => dead.on("close", resolve));
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: dead.pid })}\n`, "utf8");
  const reused = acquireWatcherLock(lockPath, { holderPid: process.pid });
  reused.release();
});

const responderPath = fileURLToPath(new URL("../clients/responder.js", import.meta.url));

function runResponderCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [responderPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // Dead hub: a regression that reaches the network must fail fast here,
      // never connect to the real hub or wedge the suite.
      env: { ...process.env, MSGHUB_BASE: "http://127.0.0.1:1", ...env },
    });
    let stderr = "";
    let done = false;
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => finish("timeout"), 10_000);
    child.on("close", (code) => finish(code));
  });
}

test("--listen-minutes: invalid flag value exits 2 with a usage error", async () => {
  const r = await runResponderCli(["run", "--identity", "x", "--listen-minutes", "abc"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /listen-minutes/);
});

test("--listen-minutes: invalid MSGHUB_LISTEN_MIN fallback exits 2", async () => {
  const r = await runResponderCli(["run", "--identity", "x"], { MSGHUB_LISTEN_MIN: "-1" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /listen-minutes/);
});

test("unknown backend exits 15 and names the registered ones", async () => {
  const r = await runResponderCli(["run", "--identity", "x", "--backend", "nope"]);
  assert.equal(r.code, 15);
  assert.match(r.stderr, /unsupported backend: nope/);
  assert.match(r.stderr, /openclaw/);
});

test("openclaw without an explicit model exits 15 naming the env var", async () => {
  const r = await runResponderCli(["run", "--identity", "x", "--backend", "openclaw"], {
    RESPONDER_OPENCLAW_MODEL: "",
    OPENCLAW_ENTRY: "",
    OPENCLAW_MSGHUB_CONFIG: "",
  });
  assert.equal(r.code, 15);
  assert.match(r.stderr, /RESPONDER_OPENCLAW_MODEL/);
});
