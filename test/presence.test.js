import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createPresence } from "../lib/presence.js";
import { createHub } from "../lib/hub.js";

// ---------- unit: createPresence ----------

function fakeClock(start = 1_000_000) {
  return { t: start, now: () => this?.t ?? start };
}

function makePresence({ onlineTtlMs = 45_000, typingTtlMs = 8_000 } = {}) {
  const clock = { t: 1_000_000 };
  const presence = createPresence({
    now: () => clock.t,
    onlineTtlMs,
    typingTtlMs,
  });
  return { presence, tick: (ms) => { clock.t += ms; } };
}

test("presence: SSE attach/detach counts connections and drives online", () => {
  const { presence } = makePresence();
  presence.attach("xing");
  let snap = presence.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].identity, "xing");
  assert.equal(snap[0].connections, 1);
  assert.equal(snap[0].online, true);
  assert.equal(snap[0].typing, false);

  presence.attach("xing");
  assert.equal(presence.snapshot()[0].connections, 2);

  presence.detach("xing");
  assert.equal(presence.snapshot()[0].connections, 1);
  presence.detach("xing");
  snap = presence.snapshot();
  assert.equal(snap[0].connections, 0);
  assert.equal(snap[0].online, true); // detach stamps last_seen: grace window until onlineTtl expires
});

test("presence: detached identity stays online for the online TTL, then expires", () => {
  const { presence, tick } = makePresence();
  presence.attach("xing");
  presence.detach("xing");
  assert.equal(presence.snapshot()[0].online, true);
  tick(44_000);
  assert.equal(presence.snapshot()[0].online, true);
  tick(2_000);
  assert.deepEqual(presence.snapshot(), []);
});

test("presence: typing shows within typing TTL and clears after it", () => {
  const { presence, tick } = makePresence();
  presence.attach("yao");
  presence.touch("yao", "typing");
  assert.equal(presence.snapshot()[0].typing, true);
  tick(7_000);
  assert.equal(presence.snapshot()[0].typing, true);
  tick(2_000);
  const snap = presence.snapshot()[0];
  assert.equal(snap.typing, false);
  assert.equal(snap.online, true); // still within online TTL
});

test("presence: POST-only client (touch, no SSE) counts as online", () => {
  const { presence, tick } = makePresence();
  presence.touch("cc", "online");
  assert.equal(presence.snapshot()[0].online, true);
  tick(46_000);
  assert.deepEqual(presence.snapshot(), []);
});

test("presence: heartbeat refreshes last_seen without changing state", () => {
  const { presence, tick } = makePresence({ onlineTtlMs: 1_000 });
  presence.attach("xing");
  tick(900);
  presence.heartbeat("xing");
  tick(900);
  const snap = presence.snapshot();
  assert.equal(snap.length, 1); // refreshed, not expired
  assert.equal(snap[0].online, true);
  assert.equal(snap[0].typing, false);
});

test("presence: touch rejects unknown states and bad identities", () => {
  const { presence } = makePresence();
  assert.throws(() => presence.touch("cc", "away"));
  assert.throws(() => presence.touch("BAD ID", "online"));
  assert.throws(() => presence.attach("BAD ID"));
});

test("presence: detach never goes negative and unknown detach is safe", () => {
  const { presence } = makePresence();
  presence.detach("ghost");
  presence.attach("xing");
  presence.detach("xing");
  presence.detach("xing");
  assert.equal(presence.snapshot()[0].connections, 0);
});

test("presence: entries of different identities are independent", () => {
  const { presence, tick } = makePresence();
  presence.attach("xing");
  presence.touch("yao", "typing");
  tick(10_000); // yao typing expired, xing untouched
  const byId = Object.fromEntries(presence.snapshot().map((e) => [e.identity, e]));
  assert.equal(byId.xing.online, true);
  assert.equal(byId.yao.typing, false);
});

// ---------- HTTP: hub routes ----------

function makeConfig(dir) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    tokenFile: path.join(dir, "data", "token.txt"),
    logDir: path.join(dir, "data", "logs"),
    topics: ["daily", "sys"],
    ratePerMin: 1000,
    bodyLimit: 64 * 1024,
    sseMax: 10,
    replayMax: 1000,
    retentionDays: 2,
    allowedCidrs: ["127.0.0.1/32", "::1/128"],
    logMaxBytes: 10 * 1024 * 1024,
  };
}

function listen(hub) {
  return new Promise((resolve, reject) => {
    hub.server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${hub.server.address().port}`);
    });
  });
}

async function startHub(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-presence-"));
  const config = { ...makeConfig(dir), ...overrides };
  const hub = createHub(config);
  const base = await listen(hub);
  return {
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
          resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function sseClient(base, query, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      new URL(`/stream${query}`, base),
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`unexpected SSE status ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
        });
        resolve({
          res,
          text: () => buffer,
          waitFor(predicate, timeoutMs = 3000) {
            if (predicate(buffer)) return Promise.resolve(buffer);
            return new Promise((res2, rej2) => {
              const timer = setTimeout(() => rej2(new Error(`timeout; got ${buffer.slice(-200)}`)), timeoutMs);
              res.on("data", function onData() {
                if (predicate(buffer)) {
                  clearTimeout(timer);
                  res.off("data", onData);
                  res2(buffer);
                }
              });
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

test("GET /presence requires a token", async () => {
  const ctx = await startHub();
  try {
    const denied = await request(ctx.base, "/presence");
    assert.equal(denied.status, 401);
    const ok = await request(ctx.base, "/presence", { token: ctx.token });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().identities, []);
  } finally {
    await ctx.close();
  }
});

test("/stream rejects an invalid identity with 400", async () => {
  const ctx = await startHub();
  try {
    const res = await request(ctx.base, "/stream?identity=BAD%20ID", { token: ctx.token });
    assert.equal(res.status, 400);
    assert.equal(res.json().error.code, "bad_request");
  } finally {
    await ctx.close();
  }
});

test("identified SSE connection appears in /presence and leaves on close", async () => {
  const ctx = await startHub();
  try {
    const client = await sseClient(ctx.base, "?identity=xing", ctx.token);
    await client.waitFor((b) => b.includes("retry:"));
    let snap = (await request(ctx.base, "/presence", { token: ctx.token })).json().identities;
    const xing = snap.find((e) => e.identity === "xing");
    assert.ok(xing, "xing should be present");
    assert.equal(xing.connections, 1);
    assert.equal(xing.online, true);

    client.close();
    await new Promise((r) => setTimeout(r, 150));
    snap = (await request(ctx.base, "/presence", { token: ctx.token })).json().identities;
    const after = snap.find((e) => e.identity === "xing");
    assert.equal(after?.connections ?? 0, 0);
  } finally {
    await ctx.close();
  }
});

test("POST /presence marks typing; invalid body is rejected", async () => {
  const ctx = await startHub();
  try {
    const ok = await request(ctx.base, "/presence", {
      method: "POST",
      token: ctx.token,
      body: { from: "yao", state: "typing" },
    });
    assert.equal(ok.status, 200);
    const snap = (await request(ctx.base, "/presence", { token: ctx.token })).json().identities;
    const yao = snap.find((e) => e.identity === "yao");
    assert.equal(yao.typing, true);
    assert.equal(yao.online, true);

    const badState = await request(ctx.base, "/presence", {
      method: "POST",
      token: ctx.token,
      body: { from: "yao", state: "away" },
    });
    assert.equal(badState.status, 400);

    const badFrom = await request(ctx.base, "/presence", {
      method: "POST",
      token: ctx.token,
      body: { from: "BAD ID", state: "typing" },
    });
    assert.equal(badFrom.status, 400);
  } finally {
    await ctx.close();
  }
});

test("POST /presence is rate limited per identity", async () => {
  const ctx = await startHub();
  try {
    let got429 = false;
    for (let i = 0; i < 125; i++) {
      const res = await request(ctx.base, "/presence", {
        method: "POST",
        token: ctx.token,
        body: { from: "yao", state: "online" },
      });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    assert.equal(got429, true);
  } finally {
    await ctx.close();
  }
});

test("presence calls never change last_id or write to the JSONL", async () => {
  const ctx = await startHub();
  try {
    await request(ctx.base, "/send", {
      method: "POST",
      token: ctx.token,
      body: { from: "cc", topic: "daily", body: "hi @dsh" },
    });
    const health1 = (await request(ctx.base, "/health")).json();
    await request(ctx.base, "/presence", { method: "POST", token: ctx.token, body: { from: "dsh", state: "typing" } });
    await request(ctx.base, "/presence", { token: ctx.token });
    await request(ctx.base, "/presence", { method: "POST", token: ctx.token, body: { from: "dsh", state: "idle" } });
    const health2 = (await request(ctx.base, "/health")).json();
    assert.equal(health2.last_id, health1.last_id);
    assert.equal(health2.last_id, 1); // only the /send appended a line
  } finally {
    await ctx.close();
  }
});

test("unidentified SSE clients still connect (backward compatible)", async () => {
  const ctx = await startHub();
  try {
    const client = await sseClient(ctx.base, "", ctx.token);
    await client.waitFor((b) => b.includes("retry:"));
    const snap = (await request(ctx.base, "/presence", { token: ctx.token })).json().identities;
    assert.deepEqual(snap, []);
    client.close();
  } finally {
    await ctx.close();
  }
});
