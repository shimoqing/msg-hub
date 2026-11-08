// msg-hub responder: watches /stream for mentions of an identity and answers
// with a real model turn. No canned replies — a failed turn means no message.
//
//   node clients/responder.js run --identity bot --backend openai --operator me
//   node clients/responder.js run --identity bot --backend command --cmd <bin> --arg <a>
//
// Model/agent backends live in ./backends.js (openclaw, claude, and generic
// HTTP/command bridges); this file owns wake rules, cursor/lock state, and the
// SSE loop. Chat bodies are passed to the model as untrusted data; any tool
// call or permission denial in the model turn aborts the reply.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRateLimiter } from "../lib/auth.js";

import { BACKENDS, buildPrompt, buildSystemPrompt, buildUserPrompt, getBackend, runBackendTurn } from "./backends.js";

export {
  buildPrompt,
  childEnv,
  claudeArgs,
  claudeReplyText,
  extractClaudeResult,
  extractEnvelope,
  extractReplyText,
  makeTurnGuard,
  openClawArgs,
} from "./backends.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Watcher control files live under data/watchers/<identity>/ — deliberately
// OUTSIDE any model workspace, so a hijacked model turn cannot rewrite the
// cursor, steal the lock, or read another watcher's prompt file.
const WATCHERS_DIR = path.join(PROJECT_ROOT, "data", "watchers");

const IDENTITY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const MAX_REPLY_CHARS = 4000;
const CATCHUP_PAGE = 500;
const RECONNECT_MS = 3000;
const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 2;
const MAX_CONSEC_FAILS = 3;
const SEND_PER_MIN = 9; // server allows 10/min per from; stay under it

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionRegex(identity) {
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(identity)}(?![\\w-])`);
}

export function allMentionRegex() {
  return /(^|[^\w-])@all(?![\w-])/;
}

export function parseHop(body) {
  let hop = 0;
  for (const m of String(body ?? "").matchAll(/\[hop:(\d+)\]/g)) {
    hop = Math.max(hop, Number(m[1]));
  }
  return hop;
}

// Compose the reply body: truncate the model text FIRST, then ensure the
// asker mention, then append the hop marker last — a marker appended before
// truncation gets cut off and silently disables the hop cap.
export function buildReplyBody({ text, from, agentOrigin = false, nextHop = 1 }) {
  const trimmed = String(text ?? "").trim();
  const askerRe = new RegExp(`^@${escapeRegExp(from)}(?![\\w-])`);
  let body = askerRe.test(trimmed) ? trimmed : `@${from} ${trimmed}`;
  if (body.length > MAX_REPLY_CHARS) body = body.slice(0, MAX_REPLY_CHARS);
  if (agentOrigin) body += ` [hop:${nextHop}]`;
  return body;
}

// Wake rules: `type:"data"` and `type:"plan"` never wake. A mention of the
// identity, @all, or a directed `to:<identity>` wakes; by default only the
// operator wakes the responder, other agents need --allow-agents and stay under
// a 2-hop cap so bots cannot chain. Directed messages (DM / file handoff) do
// not need an @ but still respect the agent-origin gate.
export function shouldWake(message, { identity, operator, allowAgents, listen }) {
  if (!message || message.type === "data" || message.type === "plan") return false;
  if (message.from === identity) return false;
  const body = String(message.body ?? "");
  const mentioned = mentionRegex(identity).test(body) || allMentionRegex().test(body);
  const directed = message.to === identity;
  if (message.from === operator) {
    if (mentioned || directed) return true;
    // Listening window: after answering one operator mention, unmentioned
    // follow-ups from the same peer keep waking this watcher until `until`.
    return Boolean(listen && message.from === listen.peer && (listen.now ?? Date.now()) < listen.until);
  }
  return Boolean(allowAgents) && (mentioned || directed) && parseHop(body) < 2;
}

export function safeLastId(messages) {
  let max = null;
  for (const m of messages ?? []) {
    if (Number.isInteger(m?.id) && (max === null || m.id > max)) max = m.id;
  }
  return max;
}

// Same liveness rule as the hub lock: only ESRCH proves death; EPERM on
// Windows means the process exists. Stale locks are stolen via rename — a
// plain read-then-unlink lets two racers delete each other's fresh locks and
// both "acquire".
function stealStaleLock(lockPath, expectedRaw) {
  const stealPath = `${lockPath}.steal`;
  try {
    fs.renameSync(lockPath, stealPath);
  } catch {
    return; // someone else moved it; caller re-reads and retries
  }
  try {
    const actual = fs.readFileSync(stealPath, "utf8");
    if (actual === expectedRaw) {
      fs.unlinkSync(stealPath);
    } else {
      // We moved a lock that changed since we probed it: put it back and let
      // the next attempt see the (possibly live) new owner.
      try {
        fs.renameSync(stealPath, lockPath);
      } catch {
        try {
          fs.unlinkSync(stealPath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    try {
      fs.unlinkSync(stealPath);
    } catch {
      /* ignore */
    }
  }
}

export function acquireWatcherLock(lockPath, { holderPid = process.pid, kill = process.kill } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const payload = `${JSON.stringify({ pid: holderPid, started_at: new Date().toISOString() })}\n`;
      fs.writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
      return {
        path: lockPath,
        pid: holderPid,
        release() {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let raw = null;
      let lock = null;
      try {
        raw = fs.readFileSync(lockPath, "utf8");
        lock = JSON.parse(raw);
      } catch {
        /* corrupt lock: reclaim */
      }
      const pid = lock?.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        stealStaleLock(lockPath, raw);
        continue;
      }
      let alive = true;
      try {
        kill(pid, 0);
      } catch (probeErr) {
        alive = probeErr.code !== "ESRCH";
      }
      if (alive) {
        throw Object.assign(new Error(`another watcher holds ${lockPath} (pid ${pid})`), {
          code: "EEXIST",
          pid,
        });
      }
      stealStaleLock(lockPath, raw);
    }
  }
  throw new Error(`could not acquire ${lockPath}`);
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      // --key=value: the value may itself start with "--" (--arg=--json).
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        i += 1;
      }
    }
    // Repeatable flags (--arg) aggregate into arrays; every existing flag is
    // single-use, so nothing else changes shape.
    out[key] = out[key] === undefined ? value : Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
  }
  return out;
}

function loadToken() {
  if (process.env.MSGHUB_TOKEN) return process.env.MSGHUB_TOKEN.trim();
  const tokenFile = process.env.MSGHUB_TOKEN_FILE || path.join(PROJECT_ROOT, "data", "token.txt");
  return fs.readFileSync(path.resolve(tokenFile), "utf8").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args._[0] !== "run") {
    console.error(
      "usage: node clients/responder.js run --identity <id> [--backend openclaw|claude|command|openai|anthropic] [--operator <id>] [--display-name <name>] [--from <id>] [--allow-agents] [--listen-minutes <0..1440>] [--model <model>]",
    );
    process.exitCode = 2;
    return;
  }
  const identity = String(args.identity ?? "");
  if (!IDENTITY_RE.test(identity)) {
    console.error(`invalid identity: ${identity}`);
    process.exitCode = 15;
    return;
  }
  const backendName = String(args.backend ?? "openclaw");
  const backend = getBackend(backendName);
  if (!backend) {
    console.error(`unsupported backend: ${backendName} (${Object.keys(BACKENDS).join("|")})`);
    process.exitCode = 15;
    return;
  }
  const operator = String(args.operator ?? process.env.MSGHUB_OPERATOR ?? "me");
  if (!IDENTITY_RE.test(operator)) {
    console.error(`invalid operator: ${operator}`);
    process.exitCode = 15;
    return;
  }
  const allowAgents = Boolean(args["allow-agents"]);
  const listenRaw = args["listen-minutes"] ?? process.env.MSGHUB_LISTEN_MIN;
  let listenMinutes = 10; // default: keep listening to the operator for 10 minutes
  if (listenRaw !== undefined) {
    const n = Number(listenRaw);
    if (!Number.isInteger(n) || n < 0 || n > 1440) {
      console.error(`invalid --listen-minutes: ${listenRaw} (expected integer 0..1440)`);
      process.exitCode = 2;
      return;
    }
    listenMinutes = n;
  }
  let cfg;
  try {
    cfg = backend.resolveConfig({ args, env: process.env });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 15;
    return;
  }
  const hub = String(args.hub ?? process.env.MSGHUB_BASE ?? "http://127.0.0.1:18795").replace(/\/$/, "");
  const token = loadToken();
  const log = (...parts) => console.log(`[watcher:${identity}]`, ...parts);

  try {
    backend.preflight(cfg, { existsSync: fs.existsSync, log });
  } catch {
    process.exitCode = 15;
    return;
  }

  // Control files outside any model workspace (data/watchers/<identity>/).
  const watcherDir = path.join(WATCHERS_DIR, identity);
  fs.mkdirSync(watcherDir, { recursive: true });
  const stateFile = path.join(watcherDir, "state.json");
  const lockPath = path.join(watcherDir, "watcher.lock");
  const promptFile = path.join(watcherDir, "prompt.tmp.txt");
  const stateDir = path.join(watcherDir, "openclaw-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const limiter = createRateLimiter({ perMin: SEND_PER_MIN });

  let lock;
  try {
    lock = acquireWatcherLock(lockPath);
  } catch (err) {
    log(err.message);
    process.exitCode = 3;
    return;
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  async function apiJson(pathname) {
    const res = await fetch(`${hub}${pathname}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
    return res.json();
  }

  let running = true;
  let sseCtrl = null;
  let consecFails = 0;
  let cursor;
  const saved = (() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return null;
    }
  })();
  let listenState =
    saved && typeof saved.listen?.peer === "string" && typeof saved.listen?.until === "number"
      ? { peer: saved.listen.peer, until: saved.listen.until }
      : null;

  function saveState() {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ cursor, listen: listenState, updated_at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(tmp, stateFile);
  }

  function cleanup() {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* not present */
    }
    lock.release();
  }

  async function postReply(message, body) {
    const check = limiter.check(identity);
    if (!check.allowed) await sleep(Math.min(check.retryAfter + 1, 65) * 1000);
    const send = async () => {
      const res = await fetch(`${hub}/send`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: identity,
          to: message.from,
          topic: message.topic,
          type: "chat",
          body,
          reply_to: message.id,
        }),
      });
      return { status: res.status, retryAfter: Number(res.headers.get("retry-after")) || 0, json: await res.json().catch(() => null) };
    };
    let r = await send();
    if (r.status === 429) {
      await sleep(Math.min(r.retryAfter + 1, 65) * 1000);
      r = await send();
    }
    if (r.status !== 201) throw new Error(`POST /send -> ${r.status}`);
    return r.json?.message?.id ?? null;
  }

  async function answerOnce(message) {
    // Crash-replay guard: page /since forward to head, so a reply posted long
    // ago (backlog > 1000) is still found — a single page would miss it.
    let already = false;
    let scanFrom = message.id;
    for (;;) {
      const page = await apiJson(`/since/${scanFrom}?limit=1000`);
      const msgs = page.messages ?? [];
      already = msgs.some((m) => m.from === identity && m.reply_to === message.id);
      if (already || msgs.length < 1000) break;
      scanFrom = msgs[msgs.length - 1].id;
    }
    if (already) {
      log(`id=${message.id} skip: reply already exists`);
      return "skip";
    }

    const displayName = String(args["display-name"] ?? process.env.MSGHUB_DISPLAY_NAME ?? identity);
    const promptParts = { identity, displayName };
    const prompt = buildPrompt({ message, identity, displayName });
    if (backend.usesPromptFile(cfg)) {
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    }
    const ctx = {
      prompt,
      system: buildSystemPrompt(promptParts),
      user: buildUserPrompt({ message }),
      promptFile,
      stateDir,
    };
    const turn = await runBackendTurn(backend, cfg, ctx, { log });
    const body = buildReplyBody({
      text: turn.text,
      from: message.from,
      agentOrigin: allowAgents && message.from !== operator,
      nextHop: parseHop(message.body) + 1,
    });

    const replyId = await postReply(message, body);
    consecFails = 0;
    if (listenMinutes > 0) {
      // The operator can keep talking without re-mentioning for a while.
      listenState = { peer: message.from, until: Date.now() + listenMinutes * 60_000 };
    }
    log(`id=${message.id} reply=${replyId ?? "?"} model=${turn.model} ${turn.dur}ms`);
    return "ok";
  }

  async function handleMessage(message) {
    if (!shouldWake(message, { identity, operator, allowAgents, listen: listenMinutes > 0 ? listenState : null })) {
      return "skip";
    }
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
      try {
        const outcome = await answerOnce(message);
        if (outcome === "skip") return "skip";
        return "ok";
      } catch (err) {
        consecFails += 1;
        log(`id=${message.id} attempt=${attempts} error=${err.message}`);
        if (consecFails >= MAX_CONSEC_FAILS) {
          log(`${consecFails} consecutive backend failures; going offline`);
          running = false;
          sseCtrl?.abort();
          process.exitCode = 4;
          return "fail";
        }
        if (attempts < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    return "fail";
  }

  const queue = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (running && queue.length > 0) {
        const message = queue.shift();
        if (!Number.isInteger(message?.id) || message.id <= cursor) continue;
        if (message.id > cursor + 1) {
          log(`gap before id=${message.id}; reconnecting to replay from #${cursor}`);
          sseCtrl?.abort();
          break;
        }
        const outcome = await handleMessage(message);
        if (!running) break;
        if (outcome === "fail") {
          // Do not advance past an unanswered message: going offline and
          // retrying it on restart is better than silently losing it.
          log(`id=${message.id} unanswered after ${MAX_ATTEMPTS} attempts; staying at #${cursor}, going offline`);
          running = false;
          sseCtrl?.abort();
          process.exitCode = 4;
          break;
        }
        cursor = message.id;
        saveState();
      }
    } finally {
      draining = false;
    }
  }

  function onFrame(frame) {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // ping / comment
      if (line.startsWith("data:")) data += `${line.slice(5).trim()}\n`;
    }
    if (!data) return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Number.isInteger(message?.id)) return;
    queue.push(message);
    drain();
  }

  async function catchUp() {
    for (;;) {
      const page = await apiJson(`/since/${cursor}?limit=${CATCHUP_PAGE}`);
      const messages = page.messages ?? [];
      for (const message of messages) {
        if (!running) return;
        const outcome = await handleMessage(message);
        if (!running) return;
        if (outcome === "fail") {
          log(`id=${message.id} unanswered after ${MAX_ATTEMPTS} attempts; staying at #${cursor}, going offline`);
          running = false;
          sseCtrl?.abort();
          process.exitCode = 4;
          return;
        }
        cursor = message.id;
        saveState();
      }
      if (messages.length < CATCHUP_PAGE) return;
    }
  }

  try {
    const health = await apiJson("/health");
    if (args.from !== undefined) {
      const fromId = Number(args.from);
      if (!Number.isInteger(fromId) || fromId < 1) {
        throw new Error(`--from must be a positive integer, got: ${args.from}`);
      }
      cursor = fromId - 1;
      log(`starting from --from ${fromId} (cursor #${cursor})`);
    } else if (saved && Number.isInteger(saved.cursor)) {
      cursor = saved.cursor;
      log(`resuming from state at #${cursor}`);
    } else {
      cursor = health.last_id;
      log(`starting at head #${cursor}; use --from N to answer an existing message`);
    }
    log(
      `hub=${hub} last_id=${health.last_id} backend=${backend.name} model=${cfg.model || "(env)"} allowAgents=${allowAgents} operator=${operator}`,
    );

    await catchUp();
    saveState();

    // Graceful shutdown: first Ctrl+C finishes the current step and runs
    // cleanup; second Ctrl+C (or 5s) forces exit. Model children are killed by
    // libuv's Windows job object on exit regardless.
    let interrupted = false;
    const onSignal = () => {
      if (interrupted) process.exit(0);
      interrupted = true;
      log("shutting down (Ctrl+C again to force)");
      running = false;
      sseCtrl?.abort();
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const decoder = new TextDecoder();
    while (running) {
      try {
        // Catch up via paginated /since on EVERY reconnect: SSE replay caps at
        // replayMax (1000), so a long outage would otherwise strand backlog.
        await catchUp();
        if (!running) break;
        sseCtrl = new AbortController();
        const url = `${hub}/stream?since=${cursor}&identity=${encodeURIComponent(identity)}`;
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
          signal: sseCtrl.signal,
        });
        if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
        log(`stream connected (since #${cursor})`);
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            onFrame(frame);
          }
        }
        log("stream closed by server");
      } catch (err) {
        if (!running) break;
        log(`stream error: ${err.message}; retry in ${RECONNECT_MS}ms`);
      }
      if (running) await sleep(RECONNECT_MS);
    }
  } finally {
    cleanup();
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  process.on("unhandledRejection", (err) => {
    console.error("[watcher] unhandled rejection:", err?.message ?? err);
    process.exitCode = 4;
  });
  main().catch((err) => {
    console.error("[watcher] fatal:", err?.message ?? err);
    process.exitCode = 1;
  });
}
