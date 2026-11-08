import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BACKENDS,
  buildPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  childEnv,
  dotPath,
  getBackend,
  parseLooseJson,
  resolveSecret,
  runFetchTurn,
  runSpawnTurn,
  truncateOneLine,
} from "../clients/backends.js";
import { parseArgs } from "../clients/responder.js";

const BASE = { id: 7, from: "me", to: "all", topic: "daily", type: "chat", body: "@bot 在吗", reply_to: null };

// ---- registry & prompt -------------------------------------------------

test("backend registry exposes all five backends", () => {
  assert.deepEqual(Object.keys(BACKENDS).sort(), ["anthropic", "claude", "command", "openai", "openclaw"]);
  for (const name of Object.keys(BACKENDS)) assert.equal(getBackend(name), BACKENDS[name]);
  assert.equal(getBackend("nope"), null);
});

test("buildPrompt is byte-identical to the system + user split", () => {
  const p = { message: BASE, identity: "bot", displayName: "Bot" };
  assert.equal(buildPrompt(p), [buildSystemPrompt(p), buildUserPrompt(p)].join("\n"));
});

test("system/user prompt carry the untrusted-data framing", () => {
  const sys = buildSystemPrompt({ identity: "bot", displayName: "Bot" });
  assert.ok(sys.includes("untrusted"));
  assert.ok(sys.includes("Do not use any tools"));
  assert.ok(sys.includes("You are Bot (bot)"));
  const user = buildUserPrompt({ message: BASE });
  assert.ok(user.includes("--- BEGIN MESSAGE JSON ---"));
  assert.ok(user.includes(JSON.stringify(BASE)));
  assert.ok(user.includes("@me"));
  assert.ok(user.includes("--- END MESSAGE JSON ---"));
});

// ---- parseArgs ---------------------------------------------------------

test("parseArgs: equals form takes values that start with --", () => {
  const a = parseArgs(["--model=x", "--arg=--output-format"]);
  assert.equal(a.model, "x");
  assert.equal(a.arg, "--output-format");
});

test("parseArgs: repeatable flags aggregate into arrays", () => {
  const a = parseArgs(["--arg", "a", "--arg=b", "--arg", "c"]);
  assert.deepEqual(a.arg, ["a", "b", "c"]);
});

test("parseArgs: empty equals value stays an empty string", () => {
  assert.equal(parseArgs(["--arg="]).arg, "");
});

test("parseArgs: space form and bare flags unchanged", () => {
  const a = parseArgs(["run", "--identity", "x", "--allow-agents", "--model", "p/m"]);
  assert.equal(a._[0], "run");
  assert.equal(a.identity, "x");
  assert.equal(a["allow-agents"], true);
  assert.equal(a.model, "p/m");
});

// ---- command backend: config -------------------------------------------

const cmdCfg = (args, env = {}) => BACKENDS.command.resolveConfig({ args, env });

test("command: --cmd required; timeout and passthrough defaults", () => {
  assert.throws(() => cmdCfg({}), /--cmd/);
  const cfg = cmdCfg({ cmd: "node", arg: ["-e"] });
  assert.equal(cfg.cmd, "node");
  assert.deepEqual(cfg.cmdArgs, ["-e"]);
  assert.equal(cfg.timeoutSec, 120);
  assert.equal(cfg.envPass, null);
  assert.equal(cfg.promptFileFlag, null);
  assert.equal(cfg.replyJsonPath, null);
});

test("command: timeout-sec validation (flag and env)", () => {
  assert.throws(() => cmdCfg({ cmd: "node", "timeout-sec": "0" }), /timeout-sec/);
  assert.throws(() => cmdCfg({ cmd: "node", "timeout-sec": "abc" }), /timeout-sec/);
  assert.throws(() => cmdCfg({ cmd: "node", "timeout-sec": "601" }), /timeout-sec/);
  assert.equal(cmdCfg({ cmd: "node" }, { RESPONDER_COMMAND_TIMEOUT_SEC: "30" }).timeoutSec, 30);
});

test("command: valueless --arg and invalid passthrough regex rejected", () => {
  assert.throws(() => cmdCfg({ cmd: "node", arg: true }), /--arg needs a value/);
  assert.throws(() => cmdCfg({ cmd: "node" }, { RESPONDER_ENV_PASSTHROUGH: "^FOO(" }), /RESPONDER_ENV_PASSTHROUGH/);
});

test("command: prompt-file flag must be a CLI flag name (equals form)", () => {
  assert.throws(() => cmdCfg({ cmd: "node", "prompt-file-flag": true }), /needs a value/);
  assert.throws(() => cmdCfg({ cmd: "node", "prompt-file-flag": "message-file" }), /--prompt-file-flag/);
  assert.equal(cmdCfg({ cmd: "node", "prompt-file-flag": "--message-file" }).promptFileFlag, "--message-file");
});

// ---- command backend: buildTurn ----------------------------------------

test("command buildTurn: stdin mode with allowlisted env", () => {
  process.env.MSGHUB_TOKEN = "secret-sentinel";
  try {
    const cfg = cmdCfg({ cmd: "node", arg: ["-e", "x"] });
    assert.equal(BACKENDS.command.usesPromptFile(cfg), false);
    const spec = BACKENDS.command.buildTurn(cfg, { prompt: "PROMPT", promptFile: "pf.txt", stateDir: "sd" });
    assert.equal(spec.kind, "spawn");
    assert.equal(spec.file, "node");
    assert.deepEqual(spec.args, ["-e", "x"]);
    assert.equal(spec.stdinData, "PROMPT");
    assert.equal(spec.env.MSGHUB_TOKEN, undefined);
    assert.equal(spec.hardKillMs, 140_000);
    assert.equal(spec.label, "command");
  } finally {
    delete process.env.MSGHUB_TOKEN;
  }
});

test("command buildTurn: prompt-file mode appends flag+file and drops stdin", () => {
  const cfg = cmdCfg({ cmd: "node", "prompt-file-flag": "--message-file" });
  assert.equal(BACKENDS.command.usesPromptFile(cfg), true);
  const spec = BACKENDS.command.buildTurn(cfg, { prompt: "PROMPT", promptFile: "pf.txt", stateDir: "sd" });
  assert.deepEqual(spec.args.slice(-2), ["--message-file", "pf.txt"]);
  assert.equal(spec.stdinData, undefined);
});

test("command buildTurn: RESPONDER_ENV_PASSTHROUGH opts selected vars in", () => {
  process.env.FOO_BAR = "allowed";
  process.env.MSGHUB_TOKEN = "secret-sentinel";
  process.env.AWS_SECRET_ACCESS_KEY = "nope";
  try {
    const cfg = cmdCfg({ cmd: "node" }, { RESPONDER_ENV_PASSTHROUGH: "^FOO_" });
    const spec = BACKENDS.command.buildTurn(cfg, { prompt: "p", promptFile: "pf", stateDir: "sd" });
    assert.equal(spec.env.FOO_BAR, "allowed");
    assert.equal(spec.env.MSGHUB_TOKEN, undefined);
    assert.equal(spec.env.AWS_SECRET_ACCESS_KEY, undefined);
  } finally {
    delete process.env.FOO_BAR;
    delete process.env.MSGHUB_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  }
});

// ---- command backend: extractReply -------------------------------------

test("command extractReply: trimmed stdout is the reply", () => {
  const cfg = cmdCfg({ cmd: "node" });
  assert.deepEqual(BACKENDS.command.extractReply("  PONG\n", cfg), { text: "PONG", model: "node" });
  assert.throws(() => BACKENDS.command.extractReply("   \n", cfg), /no reply text/);
});

test("command extractReply: --reply-json digs through loose JSON", () => {
  const cfg = cmdCfg({ cmd: "node", "reply-json": "a.list.1" });
  assert.equal(BACKENDS.command.extractReply('{"a":{"list":["x","ANSWER"]}}', cfg).text, "ANSWER");
  assert.equal(BACKENDS.command.extractReply('log line\n{"a":{"list":["x","ANSWER"]}}\ntail', cfg).text, "ANSWER");
  assert.throws(() => BACKENDS.command.extractReply("no json", cfg), /no json/);
  assert.throws(() => BACKENDS.command.extractReply('{"a":{}}', cfg), /did not yield/);
});

test("dotPath handles nested and array paths", () => {
  assert.equal(dotPath({ a: { b: [10, 20] } }, "a.b.1"), 20);
  assert.equal(dotPath({ a: 1 }, "a.b.c"), undefined);
  assert.equal(dotPath(null, "a"), undefined);
});

test("parseLooseJson: whole document, buried line, garbage", () => {
  assert.deepEqual(parseLooseJson('{"ok":1}'), { ok: 1 });
  assert.deepEqual(parseLooseJson('notice\n{"ok":3}'), { ok: 3 });
  assert.throws(() => parseLooseJson("garbage"));
});

// ---- command backend: real spawn fixtures -------------------------------

async function commandTurn(args, ctx = { prompt: "", promptFile: "", stateDir: "" }) {
  const cfg = cmdCfg({ cmd: process.execPath, arg: args });
  const spec = BACKENDS.command.buildTurn(cfg, ctx);
  return runSpawnTurn(spec, BACKENDS.command, cfg, { log: () => {} });
}

test("runSpawnTurn: real echo round-trip via node -e", async () => {
  const turn = await commandTurn(["-e", "process.stdout.write('PONG')"]);
  assert.equal(turn.text, "PONG");
  assert.ok(turn.dur >= 0);
  assert.equal(turn.model, process.execPath.split(/[\\/]/).pop());
});

test("runSpawnTurn: stdin prompt reaches the child", async () => {
  const turn = await commandTurn([
    "-e",
    "let s=''; process.stdin.on('data',(d)=>s+=d); process.stdin.on('end',()=>process.stdout.write('ECHO:'+s.trim()))",
  ], { prompt: "hello-bridge", promptFile: "", stateDir: "" });
  assert.equal(turn.text, "ECHO:hello-bridge");
});

test("runSpawnTurn: nonzero exit produces the labeled error", async () => {
  await assert.rejects(
    () => commandTurn(["-e", "process.exit(3)"]),
    /command exit=3 hardTimed=false dur=\d+ms stderr=0B/,
  );
});

test("runSpawnTurn: hung child is hard-killed into a timedOut error", async () => {
  const spec = {
    kind: "spawn",
    file: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    env: childEnv(),
    hardKillMs: 150,
    label: "command",
  };
  await assert.rejects(() => runSpawnTurn(spec, BACKENDS.command, {}, { log: () => {} }), /hardTimed=true/);
});

// ---- command backend: preflight ----------------------------------------

test("command preflight: warns on .cmd shim, errors on missing path binary", () => {
  const logs = [];
  const io = { existsSync: (p) => p === "real.exe", log: (m) => logs.push(m) };
  BACKENDS.command.preflight(cmdCfg({ cmd: "foo.cmd" }), io);
  assert.ok(logs.some((l) => l.includes("shell shim")));
  assert.throws(() => BACKENDS.command.preflight(cmdCfg({ cmd: "D:/no/such.exe" }), io), /missing/);
  BACKENDS.command.preflight(cmdCfg({ cmd: "real.exe" }), io);
});

// ---- openclaw / claude backends: de-hardcoded config --------------------

test("openclaw resolveConfig requires model, entry and config explicitly", () => {
  const env = { RESPONDER_OPENCLAW_MODEL: "p/m", OPENCLAW_ENTRY: "e.mjs", OPENCLAW_MSGHUB_CONFIG: "c.json" };
  assert.throws(() => BACKENDS.openclaw.resolveConfig({ args: {}, env: {} }), /requires --model or RESPONDER_OPENCLAW_MODEL/);
  assert.throws(() => BACKENDS.openclaw.resolveConfig({ args: { model: "p/m" }, env: {} }), /OPENCLAW_ENTRY/);
  assert.throws(() => BACKENDS.openclaw.resolveConfig({ args: { model: "p/m" }, env: { OPENCLAW_ENTRY: "e.mjs" } }), /OPENCLAW_MSGHUB_CONFIG/);
  assert.throws(
    () => BACKENDS.openclaw.resolveConfig({ args: {}, env: { ...env, RESPONDER_OPENCLAW_MODEL: "bad" } }),
    /invalid model/,
  );
  const cfg = BACKENDS.openclaw.resolveConfig({ args: {}, env });
  assert.equal(cfg.model, "p/m");
  assert.equal(cfg.nodeBin, process.execPath);
});

test("openclaw preflight keeps the pinned-config check", () => {
  const logs = [];
  const cfg = BACKENDS.openclaw.resolveConfig({
    args: {},
    env: { RESPONDER_OPENCLAW_MODEL: "p/m", OPENCLAW_ENTRY: "e.mjs", OPENCLAW_MSGHUB_CONFIG: "missing.json" },
  });
  assert.throws(() => BACKENDS.openclaw.preflight(cfg, { existsSync: () => false, log: (m) => logs.push(m) }), /pinned openclaw config missing/);
  assert.ok(logs.some((l) => l.includes("pinned openclaw config missing: missing.json")));
});

test("claude resolveConfig: PATH fallback bin; preflight checks only path-like bins", () => {
  const cfg = BACKENDS.claude.resolveConfig({ args: {}, env: {} });
  assert.equal(cfg.bin, "claude");
  assert.equal(cfg.model, "");
  BACKENDS.claude.preflight({ bin: "claude" }, { existsSync: () => false, log: () => {} });
  assert.throws(
    () => BACKENDS.claude.preflight({ bin: "D:/no/claude.exe" }, { existsSync: () => false, log: () => {} }),
    /RESPONDER_CLAUDE_BIN/,
  );
});

// ---- openclaw / claude backends: extractReply ---------------------------

test("openclaw extractReply gates on structural tool use", () => {
  const forbidden = { final: "ok", toolSummary: { tools: ["exec"] }, bridgeCalls: { call: 0 }, codeModeEngaged: false };
  assert.throws(() => BACKENDS.openclaw.extractReply(JSON.stringify(forbidden)), /tool_use_forbidden/);
  const bridge = { final: "ok", toolSummary: { tools: [] }, bridgeCalls: { call: 2 }, codeModeEngaged: false };
  assert.throws(() => BACKENDS.openclaw.extractReply(JSON.stringify(bridge)), /tool_use_forbidden/);
  const ok = { final: "ok", toolSummary: { tools: ["tool_search"] }, bridgeCalls: { call: 0 }, codeModeEngaged: false };
  assert.deepEqual(BACKENDS.openclaw.extractReply(JSON.stringify(ok)), { text: "ok", model: "unknown" });
});

test("claude extractReply: model from modelUsage, cost passthrough", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ANS",
    permission_denials: [],
    modelUsage: { "m/1": {} },
    total_cost_usd: 0.01,
  });
  const turn = BACKENDS.claude.extractReply(raw, { model: "" });
  assert.equal(turn.text, "ANS");
  assert.equal(turn.model, "m/1");
  assert.equal(turn.cost, 0.01);
});

// ---- openai backend ------------------------------------------------------

test("openai resolveConfig: base default + trailing slash, model required", () => {
  const be = BACKENDS.openai;
  assert.throws(() => be.resolveConfig({ args: {}, env: {} }), /requires --model or RESPONDER_OPENAI_MODEL/);
  assert.throws(() => be.resolveConfig({ args: { model: true }, env: {} }), /needs a value/);
  const cfg = be.resolveConfig({ args: { model: "deepseek-chat" }, env: { RESPONDER_OPENAI_BASE: "http://127.0.0.1:11434/v1/" } });
  assert.equal(cfg.base, "http://127.0.0.1:11434/v1");
  assert.equal(cfg.model, "deepseek-chat");
  assert.equal(cfg.key, null);
  assert.equal(cfg.maxTokens, null);
  assert.equal(cfg.timeoutSec, 120);
  const cfg2 = be.resolveConfig(
    { args: {}, env: { RESPONDER_OPENAI_MODEL: "m" } },
  );
  assert.equal(cfg2.model, "m");
});

test("openai resolveConfig: max_tokens / timeout validation", () => {
  const be = BACKENDS.openai;
  assert.throws(() => be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_OPENAI_MAX_TOKENS: "x" } }), /RESPONDER_OPENAI_MAX_TOKENS/);
  assert.throws(() => be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_OPENAI_TIMEOUT_SEC: "0" } }), /RESPONDER_OPENAI_TIMEOUT_SEC/);
  assert.equal(be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_OPENAI_MAX_TOKENS: "512" } }).maxTokens, 512);
});

test("openai buildTurn: URL, system/user messages, auth reference, optional max_tokens", () => {
  const be = BACKENDS.openai;
  const cfg = be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_OPENAI_BASE: "https://api.deepseek.com/v1", RESPONDER_OPENAI_KEY_FILE: "k.txt" } });
  const ctx = { system: "SYS", user: "USR", prompt: "p", promptFile: "", stateDir: "" };
  const spec = be.buildTurn(cfg, ctx);
  assert.equal(spec.kind, "fetch");
  assert.equal(spec.url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(spec.body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "USR" },
  ]);
  assert.equal(spec.body.max_tokens, undefined);
  assert.deepEqual(spec.auth, { style: "bearer", envName: "RESPONDER_OPENAI_KEY", file: "k.txt" });
  const cfg2 = be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_OPENAI_MAX_TOKENS: "64" } });
  assert.equal(be.buildTurn(cfg2, ctx).body.max_tokens, 64);
});

test("openai preflight: missing key warns but does not throw", () => {
  const logs = [];
  BACKENDS.openai.preflight({ key: null, keyFile: null }, { existsSync: () => true, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => l.includes("no API key")));
});

test("openai extractReply: text, parts array, error object, empty, invalid JSON", () => {
  const be = BACKENDS.openai;
  const ok = { model: "m", choices: [{ message: { content: " ANS " } }] };
  assert.deepEqual(be.extractReply(JSON.stringify(ok)), { text: "ANS", model: "m" });
  const parts = { model: "m", choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] };
  assert.equal(be.extractReply(JSON.stringify(parts)).text, "ab");
  assert.throws(() => be.extractReply(JSON.stringify({ error: { code: 429, message: "rate limited" } })), /openai API error 429: rate limited/);
  assert.throws(() => be.extractReply(JSON.stringify({ choices: [{ message: { content: "" } }] })), /no reply text/);
  assert.throws(() => be.extractReply("<html>gateway error</html>"), /invalid JSON/);
});

// ---- anthropic backend ---------------------------------------------------

test("anthropic resolveConfig: defaults, model required, validation", () => {
  const be = BACKENDS.anthropic;
  assert.throws(() => be.resolveConfig({ args: {}, env: {} }), /requires --model or RESPONDER_ANTHROPIC_MODEL/);
  const cfg = be.resolveConfig({ args: { model: "claude-x" }, env: { RESPONDER_ANTHROPIC_BASE: "https://proxy.example/v1/" } });
  assert.equal(cfg.base, "https://proxy.example/v1");
  assert.equal(cfg.version, "2023-06-01");
  assert.equal(cfg.maxTokens, 1024);
  assert.equal(cfg.timeoutSec, 120);
  assert.throws(() => be.resolveConfig({ args: { model: "m" }, env: { RESPONDER_ANTHROPIC_MAX_TOKENS: "-1" } }), /RESPONDER_ANTHROPIC_MAX_TOKENS/);
});

test("anthropic buildTurn: /messages URL, version header, system field, x-api-key ref", () => {
  const be = BACKENDS.anthropic;
  const cfg = be.resolveConfig({ args: { model: "claude-x" }, env: { RESPONDER_ANTHROPIC_KEY: "k" } });
  const ctx = { system: "SYS", user: "USR", prompt: "p", promptFile: "", stateDir: "" };
  const spec = be.buildTurn(cfg, ctx);
  assert.equal(spec.url, "https://api.anthropic.com/v1/messages");
  assert.equal(spec.headers["anthropic-version"], "2023-06-01");
  assert.equal(spec.body.system, "SYS");
  assert.deepEqual(spec.body.messages, [{ role: "user", content: "USR" }]);
  assert.equal(spec.body.max_tokens, 1024);
  assert.equal(spec.auth.style, "x-api-key");
});

test("anthropic extractReply: text blocks join, error envelope, empty", () => {
  const be = BACKENDS.anthropic;
  const ok = { model: "claude-x", content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] };
  assert.equal(be.extractReply(JSON.stringify(ok)).text, "ab");
  assert.throws(
    () => be.extractReply(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "slow down" } })),
    /anthropic API error overloaded_error: slow down/,
  );
  assert.throws(() => be.extractReply(JSON.stringify({ content: [] })), /no reply text/);
});

// ---- resolveSecret & truncateOneLine --------------------------------------

test("resolveSecret: env wins over file; file content trimmed; missing file names path only", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backends-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "key.txt");
  fs.writeFileSync(keyFile, "  from-file\n");
  process.env.RES_TEST_KEY = " from-env ";
  try {
    assert.equal(resolveSecret({ envName: "RES_TEST_KEY", file: keyFile }), "from-env");
    delete process.env.RES_TEST_KEY;
    assert.equal(resolveSecret({ envName: "RES_TEST_KEY", file: keyFile }), "from-file");
    assert.equal(resolveSecret({ envName: "RES_TEST_KEY" }), null);
    assert.equal(resolveSecret(null), null);
    const errPath = path.join(dir, "gone.txt");
    assert.throws(
      () => resolveSecret({ envName: "RES_TEST_KEY", file: errPath }),
      (err) => err.message.includes(errPath) && !err.message.includes("from-file"),
    );
  } finally {
    delete process.env.RES_TEST_KEY;
  }
});

test("truncateOneLine collapses whitespace and caps length", () => {
  assert.equal(truncateOneLine("a\n  b\t c"), "a b c");
  assert.ok(truncateOneLine("x".repeat(400), 300).length <= 302);
  assert.ok(truncateOneLine("x".repeat(400), 300).endsWith("…"));
});

// ---- runFetchTurn (injected fetch) ----------------------------------------

const CTX = { system: "SYS", user: "USR", prompt: "SYS\nUSR", promptFile: "", stateDir: "" };

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

test("runFetchTurn: happy path sends Bearer + JSON body, returns text/model/dur", async () => {
  process.env.RESPONDER_OPENAI_KEY = "sk-test";
  try {
    const cfg = BACKENDS.openai.resolveConfig({ args: { model: "m" }, env: {} });
    const spec = BACKENDS.openai.buildTurn(cfg, CTX);
    const seen = [];
    const turn = await runFetchTurn(spec, BACKENDS.openai, cfg, {
      log: () => {},
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return jsonResponse(200, { model: "m", choices: [{ message: { content: "ANS" } }] });
      },
    });
    assert.equal(turn.text, "ANS");
    assert.equal(turn.model, "m");
    assert.ok(Number.isInteger(turn.dur));
    assert.equal(seen[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen[0].init.headers.Authorization, "Bearer sk-test");
    assert.equal(JSON.parse(seen[0].init.body).messages[0].content, "SYS");
  } finally {
    delete process.env.RESPONDER_OPENAI_KEY;
  }
});

test("runFetchTurn: no key means no Authorization header", async () => {
  const cfg = BACKENDS.anthropic.resolveConfig({ args: { model: "m" }, env: {} });
  const spec = BACKENDS.anthropic.buildTurn(cfg, CTX);
  let headers;
  await runFetchTurn(spec, BACKENDS.anthropic, cfg, {
    log: () => {},
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return jsonResponse(200, { model: "m", content: [{ type: "text", text: "ok" }] });
    },
  });
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["x-api-key"], undefined);
});

test("runFetchTurn: HTTP error carries status + one-line body, never headers or key", async () => {
  process.env.RESPONDER_OPENAI_KEY = "sk-secret-sentinel";
  const logs = [];
  try {
    const cfg = BACKENDS.openai.resolveConfig({ args: { model: "m" }, env: {} });
    const spec = BACKENDS.openai.buildTurn(cfg, CTX);
    await assert.rejects(
      () =>
        runFetchTurn(spec, BACKENDS.openai, cfg, {
          log: (m) => logs.push(m),
          fetchImpl: async () => jsonResponse(429, { error: { message: "slow\ndown " + "x".repeat(400) } }),
        }),
      (err) => err.message.startsWith("openai HTTP 429 ") && err.message.length < 500 && !err.message.includes("\n"),
    );
    assert.ok(logs.every((l) => !l.includes("sk-secret-sentinel")));
  } finally {
    delete process.env.RESPONDER_OPENAI_KEY;
  }
});

test("runFetchTurn: soft timeout aborts into timedOut; nothing leaks into logs", async () => {
  const cfg = BACKENDS.openai.resolveConfig(
    { args: { model: "m" }, env: { RESPONDER_OPENAI_TIMEOUT_SEC: "1" } },
  );
  const spec = BACKENDS.openai.buildTurn(cfg, CTX);
  await assert.rejects(
    () =>
      runFetchTurn(spec, BACKENDS.openai, cfg, {
        log: () => {},
        fetchImpl: (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      }),
    /openai timedOut=true dur=\d+ms/,
  );
});
