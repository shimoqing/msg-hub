import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createHub } from "../lib/hub.js";
import { VERSION } from "../lib/version.js";

function makeConfig(dir) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    tokenFile: path.join(dir, "data", "token.txt"),
    logDir: path.join(dir, "data", "logs"),
    topics: ["ctf", "src", "daily", "sys"],
    ratePerMin: 1000,
    bodyLimit: 64 * 1024,
    sseMax: 10,
    replayMax: 1000,
    retentionDays: 2,
    allowedCidrs: ["127.0.0.1/32", "::1/128"],
    logMaxBytes: 10 * 1024 * 1024,
    filesMaxBytes: 20 * 1024 * 1024,
    agentsFile: path.join(dir, "data", "agents.jsonl"),
    groupsFile: path.join(dir, "data", "groups.jsonl"),
    plansFile: path.join(dir, "data", "plans.jsonl"),
    profileFile: path.join(dir, "data", "profile.jsonl"),
    contextsFile: path.join(dir, "data", "contexts.jsonl"),
  };
}

function listen(hub) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    hub.server.once("error", onError);
    hub.server.listen(0, "127.0.0.1", () => {
      hub.server.off("error", onError);
      resolve(`http://127.0.0.1:${hub.server.address().port}`);
    });
  });
}

async function startHub(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-hub-"));
  const config = { ...makeConfig(dir), ...overrides };
  const hub = createHub(config);
  const base = await listen(hub);
  return {
    dir,
    config,
    hub,
    base,
    token: hub.token,
    async close() {
      await hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request(base, pathname, { method = "GET", token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined && requestHeaders["Content-Type"] === undefined) {
      requestHeaders["Content-Type"] = "application/json";
    }
    const req = http.request(
      new URL(pathname, base),
      { method, headers: requestHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function post(base, token, payload) {
  return request(base, "/send", { method: "POST", token, body: payload });
}

function sseClient(base, query, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      new URL(`/stream${query}`, base),
      { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`unexpected SSE status ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        let buffer = "";
        const waiters = [];
        const settle = (waiter, fn, value) => {
          clearTimeout(waiter.timer);
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          fn(value);
        };
        const notify = () => {
          for (const waiter of [...waiters]) {
            if (waiter.predicate(buffer)) settle(waiter, waiter.resolve, buffer);
          }
        };
        res.on("data", (chunk) => {
          buffer += chunk;
          notify();
        });
        res.on("close", () => {
          for (const waiter of [...waiters]) settle(waiter, waiter.reject, new Error("SSE closed"));
        });
        resolve({
          res,
          text: () => buffer,
          waitFor(predicate, timeoutMs = 3000) {
            if (predicate(buffer)) return Promise.resolve(buffer);
            return new Promise((resolveWait, rejectWait) => {
              const waiter = {
                predicate,
                resolve: resolveWait,
                reject: rejectWait,
                timer: setTimeout(() => {
                  const index = waiters.indexOf(waiter);
                  if (index >= 0) waiters.splice(index, 1);
                  rejectWait(new Error(`SSE timeout; received: ${buffer.slice(-400)}`));
                }, timeoutMs),
              };
              waiters.push(waiter);
            });
          },
          close() {
            req.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on("error", reject);
  });
}

test("health is public, API needs a token, static injects token for loopback", async () => {
  const ctx = await startHub();
  try {
    const health = await request(ctx.base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json().ok, true);
    assert.equal(health.json().last_id, 0);

    const denied = await request(ctx.base, "/messages");
    assert.equal(denied.status, 401);
    assert.equal(denied.json().error.code, "unauthorized");

    const index = await request(ctx.base, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers["cache-control"], /no-store/);
    assert.ok(index.text.includes(JSON.stringify(ctx.token)));

    const app = await request(ctx.base, "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers["content-type"], /javascript/);

    assert.equal((await request(ctx.base, "/nope", { token: ctx.token })).status, 404);
    const wrongMethod = await request(ctx.base, "/messages", { method: "POST", token: ctx.token });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, "GET");
  } finally {
    await ctx.close();
  }
});

test("send validates input and reads filter by topic, recipient, and id", async () => {
  const ctx = await startHub();
  try {
    const created = await post(ctx.base, ctx.token, {
      from: "cc",
      topic: "ctf",
      body: "hello @dsh",
    });
    assert.equal(created.status, 201);
    const first = created.json().message;
    assert.equal(first.id, 1);
    assert.equal(first.to, "all");
    assert.equal(first.type, "chat");

    const second = await post(ctx.base, ctx.token, {
      from: "dsh",
      to: "cc",
      topic: "sys",
      type: "data",
      body: "E:\\共享文件夹\\a.txt",
      reply_to: first.id,
    });
    assert.equal(second.status, 201);
    assert.equal(second.json().message.id, 2);

    const ctf = await request(ctx.base, "/messages?topic=ctf", { token: ctx.token });
    assert.equal(ctf.status, 200);
    assert.deepEqual(ctf.json().messages.map((m) => m.id), [1]);
    assert.equal(ctf.json().last_id, 2);

    const directed = await request(ctx.base, "/messages?to=cc", { token: ctx.token });
    assert.deepEqual(directed.json().messages.map((m) => m.id), [1, 2]);

    const since = await request(ctx.base, "/since/1", { token: ctx.token });
    assert.deepEqual(since.json().messages.map((m) => m.id), [2]);
    assert.equal(since.json().last_id, 2);
    assert.equal(since.json().oldest_available_id, 1);

    const badJson = await request(ctx.base, "/send", {
      method: "POST",
      token: ctx.token,
      body: "{",
    });
    assert.equal(badJson.status, 400);

    const badType = await request(ctx.base, "/send", {
      method: "POST",
      token: ctx.token,
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(badType.status, 415);

    const cases = [
      { from: "CC", body: "x" },
      { from: "cc", to: "bad to", body: "x" },
      { from: "cc", topic: "nope", body: "x" },
      { from: "cc", type: "notice", body: "x" },
      { from: "cc", body: "" },
      { from: "cc", body: "x", reply_to: 0 },
    ];
    for (const payload of cases) {
      const response = await post(ctx.base, ctx.token, payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
    }
  } finally {
    await ctx.close();
  }
});

test("oversized bodies return 413 with a readable response", async () => {
  const ctx = await startHub({ bodyLimit: 512 });
  try {
    const response = await post(ctx.base, ctx.token, {
      from: "cc",
      body: "x".repeat(2000),
    });
    assert.equal(response.status, 413);
    assert.equal(response.json().error.code, "too_large");
    assert.equal(response.headers.connection, "close");
  } finally {
    await ctx.close();
  }
});

test("per-identity rate limit returns 429 and Retry-After", async () => {
  const ctx = await startHub({ ratePerMin: 2 });
  try {
    assert.equal((await post(ctx.base, ctx.token, { from: "cc", body: "1" })).status, 201);
    assert.equal((await post(ctx.base, ctx.token, { from: "cc", body: "2" })).status, 201);
    const limited = await post(ctx.base, ctx.token, { from: "cc", body: "3" });
    assert.equal(limited.status, 429);
    assert.equal(limited.json().error.code, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    assert.equal((await post(ctx.base, ctx.token, { from: "dsh", body: "4" })).status, 201);
  } finally {
    await ctx.close();
  }
});

test("SSE replays, streams live, and honors Last-Event-ID", async () => {
  const ctx = await startHub();
  try {
    await post(ctx.base, ctx.token, { from: "cc", topic: "ctf", body: "one" });
    await post(ctx.base, ctx.token, { from: "cc", topic: "sys", body: "two" });

    const replayed = await sseClient(ctx.base, "?since=0", ctx.token);
    const replayText = await replayed.waitFor((text) => /\nid: 2\n/.test(text));
    assert.match(replayText, /retry: 3000/);
    assert.match(replayText, /\nid: 1\n/);
    replayed.close();

    const live = await sseClient(ctx.base, "?since=2", ctx.token);
    await live.waitFor((text) => text.includes("retry: 3000"));
    const sent = await post(ctx.base, ctx.token, { from: "dsh", topic: "ctf", body: "live @cc" });
    assert.equal(sent.status, 201);
    const liveText = await live.waitFor((text) => text.includes("live @cc"));
    assert.match(liveText, /\nid: 3\n/);
    live.close();

    await post(ctx.base, ctx.token, { from: "cc", topic: "ctf", body: "four" });
    const headerReplay = await sseClient(ctx.base, "", ctx.token, { "Last-Event-ID": "3" });
    const headerText = await headerReplay.waitFor((text) => /\nid: 4\n/.test(text));
    assert.match(headerText, /\nid: 4\n/);
    assert.doesNotMatch(headerText, /\nid: 3\n/);
    headerReplay.close();
  } finally {
    await ctx.close();
  }
});

test("SSE connection cap returns 503", async () => {
  const ctx = await startHub({ sseMax: 1 });
  try {
    const first = await sseClient(ctx.base, "?since=0", ctx.token);
    const second = await request(ctx.base, "/stream?since=0", { token: ctx.token });
    assert.equal(second.status, 503);
    assert.equal(second.json().error.code, "too_many_clients");
    first.close();
  } finally {
    await ctx.close();
  }
});

test("access log records paths but never query strings", async () => {
  const ctx = await startHub();
  try {
    const response = await request(ctx.base, "/messages?token=THIS_MUST_NOT_BE_LOGGED", {
      token: ctx.token,
    });
    assert.equal(response.status, 200);
    const logDir = ctx.config.logDir;
    const text = fs
      .readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(logDir, name), "utf8"))
      .join("");
    assert.match(text, /GET \/messages 200/);
    assert.doesNotMatch(text, /THIS_MUST_NOT_BE_LOGGED/);
  } finally {
    await ctx.close();
  }
});

test("sources outside ALLOWED_CIDRS get 403 even for health", async () => {
  const ctx = await startHub({ allowedCidrs: ["10.0.0.0/8"] });
  try {
    const health = await request(ctx.base, "/health");
    assert.equal(health.status, 403);
    assert.equal(health.json().error.code, "forbidden_ip");
    const send = await post(ctx.base, ctx.token, { from: "cc", body: "x" });
    assert.equal(send.status, 403);
  } finally {
    await ctx.close();
  }
});

test("/state returns profile, agents, groups, plans and server in one request", async () => {
  const ctx = await startHub();
  try {
    const state = await request(ctx.base, "/state", { token: ctx.token });
    assert.equal(state.status, 200);
    const body = state.json();
    assert.equal(body.ok, true);
    assert.equal(body.profile, null);
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.groups.length, 4); // seeded legacy topics
    assert.ok(Array.isArray(body.plans));
    assert.equal(body.server.version, VERSION);
    assert.deepEqual(body.server.topics, ["ctf", "src", "daily", "sys"]);

    const denied = await request(ctx.base, "/state");
    assert.equal(denied.status, 401);
  } finally {
    await ctx.close();
  }
});

test("profile write creates a human agent and marks onboarded", async () => {
  const ctx = await startHub();
  try {
    const saved = await request(ctx.base, "/profile", {
      method: "POST",
      token: ctx.token,
      body: { operator: "youneiga", display_name: "youneiga", onboarded: true },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().profile.onboarded, true);
    const state = await request(ctx.base, "/state", { token: ctx.token });
    const human = state.json().agents.find((a) => a.id === "youneiga");
    assert.equal(human.kind, "human");
    assert.equal(human.source, "manual");
  } finally {
    await ctx.close();
  }
});

test("dynamic group topics can be written and read; archived groups reject writes", async () => {
  const ctx = await startHub();
  try {
    const created = await request(ctx.base, "/groups", {
      method: "POST",
      token: ctx.token,
      body: { name: "登录页改造", members: ["youneiga", "xing"], created_by: "youneiga" },
    });
    assert.equal(created.status, 201);
    const id = created.json().group.id;
    assert.match(id, /^g-[a-f0-9]{8}$/);

    const sent = await post(ctx.base, ctx.token, { from: "cc", topic: id, body: "in new group" });
    assert.equal(sent.status, 201);
    const read = await request(ctx.base, `/messages?topic=${id}`, { token: ctx.token });
    assert.deepEqual(read.json().messages.map((m) => m.id), [1]);

    const archived = await request(ctx.base, `/groups/${id}`, {
      method: "POST",
      token: ctx.token,
      body: { archived: true },
    });
    assert.equal(archived.status, 200);
    const rejected = await post(ctx.base, ctx.token, { from: "cc", topic: id, body: "after archive" });
    assert.equal(rejected.status, 400);
    const stillReadable = await request(ctx.base, `/messages?topic=${id}`, { token: ctx.token });
    assert.equal(stillReadable.status, 200);
    assert.equal(stillReadable.json().messages.length, 1);
  } finally {
    await ctx.close();
  }
});

test("DM creation is deterministic and a directed message needs no @", async () => {
  const ctx = await startHub();
  try {
    const first = await request(ctx.base, "/groups", {
      method: "POST",
      token: ctx.token,
      body: { kind: "dm", members: ["youneiga", "xing"] },
    });
    const second = await request(ctx.base, "/groups", {
      method: "POST",
      token: ctx.token,
      body: { kind: "dm", members: ["xing", "youneiga"] },
    });
    assert.equal(first.json().group.id, second.json().group.id);
    assert.match(first.json().group.id, /^dm-[a-f0-9]{10}$/);
    const sent = await post(ctx.base, ctx.token, {
      from: "youneiga",
      to: "xing",
      topic: first.json().group.id,
      body: "directed without @",
    });
    assert.equal(sent.status, 201);
  } finally {
    await ctx.close();
  }
});

test("client-submitted type:plan is rejected; file body is validated", async () => {
  const ctx = await startHub();
  try {
    const plan = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "plan",
      body: JSON.stringify({ plan_id: "p-deadbeef" }),
    });
    assert.equal(plan.status, 400);
    assert.equal(plan.json().error.code, "plan_reserved");

    const badFile = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: JSON.stringify({ id: "fmissing", name: "x" }),
    });
    assert.equal(badFile.status, 400);

    const badNote = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: JSON.stringify({ id: "fmissing2", note: "x".repeat(2100) }),
    });
    assert.equal(badNote.status, 400);

    const badJson = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: "not json",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await ctx.close();
  }
});

test("upload then file message fills missing metadata and rejects mismatches", async () => {
  const ctx = await startHub();
  try {
    const upload = await request(ctx.base, "/files/upload?name=note.txt&from=cc", {
      method: "POST",
      token: ctx.token,
      headers: { "Content-Type": "application/octet-stream" },
      body: "中文 + emoji 🧪\n第二行",
    });
    assert.equal(upload.status, 201);
    const file = upload.json().file;

    // Old-style client sends only id + note; server fills name/size/sha256.
    const sent = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: JSON.stringify({ id: file.id, note: "重点看第 3 节 🧪" }),
    });
    assert.equal(sent.status, 201);
    const ref = JSON.parse(sent.json().message.body);
    assert.equal(ref.name, "note.txt");
    assert.equal(ref.size, file.size);
    assert.equal(ref.sha256, file.sha256);
    assert.equal(ref.note, "重点看第 3 节 🧪");

    const mismatch = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: JSON.stringify({ id: file.id, name: "forged.txt" }),
    });
    assert.equal(mismatch.status, 400);

    const longNote = await post(ctx.base, ctx.token, {
      from: "cc",
      type: "file",
      body: JSON.stringify({ id: file.id, note: "x".repeat(2100) }),
    });
    assert.equal(longNote.status, 400);
  } finally {
    await ctx.close();
  }
});

test("agent registration and connect are loopback-gated", async () => {
  const ctx = await startHub();
  try {
    const registered = await request(ctx.base, "/agents/register", {
      method: "POST",
      token: ctx.token,
      body: { id: "yao", backend: "claude", model: "sonnet", capabilities: ["files"] },
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.json().agent.backend, "claude");

    const presets = await request(ctx.base, "/agents/presets", { token: ctx.token });
    assert.equal(presets.status, 200);
    assert.equal(presets.json().presets.length, 4);
    for (const preset of presets.json().presets) {
      assert.ok(!preset.command.includes(ctx.token), "preset command leaked the token");
    }

    // CC is a manual preset; connect must 400, not spawn anything.
    const manual = await request(ctx.base, "/agents/cc/connect", {
      method: "POST",
      token: ctx.token,
      body: {},
    });
    assert.equal(manual.status, 400);
  } finally {
    await ctx.close();
  }
});

test("context report stores ids only and GET resolves them", async () => {
  const ctx = await startHub();
  try {
    const sent = await post(ctx.base, ctx.token, { from: "cc", body: "@yao 看这里" });
    const id = sent.json().message.id;
    const report = await request(ctx.base, "/agents/yao/context", {
      method: "POST",
      token: ctx.token,
      body: {
        group: "daily",
        trigger_message_id: id,
        included_message_ids: [id],
        file_ids: [],
        reply_message_id: null,
        backend: "claude",
      },
    });
    assert.equal(report.status, 200);
    const list = await request(ctx.base, "/agents/yao/context", { token: ctx.token });
    assert.equal(list.status, 200);
    assert.equal(list.json().records.length, 1);
    assert.equal(list.json().records[0].trigger.body, "@yao 看这里");
  } finally {
    await ctx.close();
  }
});

test("plan create writes a card and start dispatches step 1", async () => {
  const ctx = await startHub();
  try {
    await request(ctx.base, "/groups", {
      method: "POST",
      token: ctx.token,
      body: { name: "分工群", members: ["youneiga", "xing", "yao"], created_by: "youneiga" },
    });
    // Use a seeded topic for simplicity.
    const created = await request(ctx.base, "/plans", {
      method: "POST",
      token: ctx.token,
      body: {
        group: "daily",
        title: "登录页改造",
        created_by: "youneiga",
        auto_handoff: false,
        steps: [
          { assignee: "xing", task: "先出方案" },
          { assignee: "yao", task: "按方案实现" },
        ],
      },
    });
    assert.equal(created.status, 201);
    const planId = created.json().plan.plan_id;

    const card = await request(ctx.base, "/messages?type=plan", { token: ctx.token });
    assert.equal(card.json().messages.length, 1);
    assert.equal(JSON.parse(card.json().messages[0].body).plan_id, planId);

    const started = await request(ctx.base, `/plans/${planId}/start`, {
      method: "POST",
      token: ctx.token,
      body: {},
    });
    assert.equal(started.status, 200);
    assert.equal(started.json().plan.status, "running");
    const dispatch = await request(ctx.base, "/messages", { token: ctx.token });
    const dispatched = dispatch.json().messages.filter((m) => m.body.includes("[分工"));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].to, "xing");
  } finally {
    await ctx.close();
  }
});

test("restart keeps the token and continues ids from JSONL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-restart-"));
  const config = makeConfig(dir);
  let hub = createHub(config);
  let base = await listen(hub);
  try {
    const first = await post(base, hub.token, { from: "cc", body: "before restart" });
    assert.equal(first.json().message.id, 1);
    const token = hub.token;
    await hub.close();

    hub = createHub(config);
    base = await listen(hub);
    assert.equal(hub.token, token);
    const health = await request(base, "/health");
    assert.equal(health.json().last_id, 1);
    const second = await post(base, hub.token, { from: "cc", body: "after restart" });
    assert.equal(second.status, 201);
    assert.equal(second.json().message.id, 2);
    const messages = await request(base, "/messages", { token: hub.token });
    assert.deepEqual(messages.json().messages.map((m) => m.id), [1, 2]);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
