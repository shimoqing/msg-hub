#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { createHub } from "../lib/hub.js";
import { Store, localDateKey, localIso } from "../lib/store.js";

const NODE = process.version;
const SILENT = { info() {}, warn() {}, error() {} };

function parseArgs(argv) {
  const out = {
    size: 10_000,
    bodyBytes: 160,
    iterations: 200,
    clients: 50,
    json: "",
    baseline: "",
    modes: "store,http,sse,send",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--size":
        out.size = Number(next());
        break;
      case "--body-bytes":
        out.bodyBytes = Number(next());
        break;
      case "--iterations":
        out.iterations = Number(next());
        break;
      case "--clients":
        out.clients = Number(next());
        break;
      case "--json":
        out.json = next();
        break;
      case "--baseline":
        out.baseline = next();
        break;
      case "--modes":
        out.modes = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(out.size) || out.size < 1) throw new Error("bad --size");
  return out;
}

function statSummary(samples) {
  if (!samples.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function maybeGc() {
  if (typeof global.gc === "function") global.gc();
}

function measure(fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(msSince(start));
  }
  return statSummary(samples);
}

function bodyFor(id, bodyBytes) {
  return `消息${id} ${"x".repeat(Math.max(0, bodyBytes))}`;
}

function seedFile(dir, dateKey, messages) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  fs.writeFileSync(path.join(dir, `chat-${dateKey}.jsonl`), lines ? `${lines}\n` : "");
}

function createFixture(dir, total, bodyBytes) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const dayBefore = new Date(today.getTime() - 2 * 86_400_000);
  const yesterdayCount = Math.floor(total * 0.4);
  const topics = ["ctf", "src", "daily", "sys"];
  const senders = ["cc", "dsh", "xing", "yao"];

  const make = (id, day, offset) => {
    const topic = topics[id % topics.length];
    const type = id % 20 === 0 ? "sys" : id % 20 === 1 ? "data" : "chat";
    const ts = new Date(day.getTime() + (offset % 43_000) * 1000);
    return {
      id,
      ts: localIso(ts),
      from: senders[id % senders.length],
      to: id % 10 === 0 ? "cc" : "all",
      topic,
      type,
      body: bodyFor(id, bodyBytes),
      reply_to: null,
    };
  };

  const oldMessages = [];
  for (let id = 1; id <= yesterdayCount; id += 1) oldMessages.push(make(id, yesterday, id));
  const newMessages = [];
  for (let id = yesterdayCount + 1; id <= total; id += 1) newMessages.push(make(id, today, id));

  seedFile(dir, localDateKey(yesterday), oldMessages);
  seedFile(dir, localDateKey(today), newMessages);
  // This file is outside the 2-day read window; it must never appear in reads.
  seedFile(dir, localDateKey(dayBefore), [
    {
      id: total + 1_000_000,
      ts: localIso(dayBefore),
      from: "cc",
      to: "all",
      topic: "daily",
      type: "chat",
      body: "outside retention",
      reply_to: null,
    },
  ]);
  return { total, today: localDateKey(today), yesterday: localDateKey(yesterday) };
}

function makeStore(dir, overrides = {}) {
  return new Store({
    dataDir: dir,
    retentionDays: 2,
    logger: SILENT,
    ...overrides,
  }).init();
}

function storeBench(dir, total, iterations) {
  const coldRecent = makeStore(dir);
  const coldStart = process.hrtime.bigint();
  coldRecent.recent({ limit: 100 });
  const coldRecentMs = msSince(coldStart);
  coldRecent.close();

  const coldSince = makeStore(dir);
  const coldSinceStart = process.hrtime.bigint();
  coldSince.since(Math.max(0, total - 1000), { limit: 200 });
  const coldSinceMs = msSince(coldSinceStart);
  coldSince.close();

  const store = makeStore(dir);
  const warm = {};
  const cases = [
    ["recent50", () => store.recent({ limit: 50 })],
    ["recentSys50", () => store.recent({ limit: 50, topic: "sys" })],
    ["sinceNear200", () => store.since(Math.max(0, total - 200), { limit: 200 })],
    ["since0_1000", () => store.since(0, { limit: 1000 })],
    ["since0ToCc1000", () => store.since(0, { limit: 1000, to: "cc" })],
  ];
  for (const [name, fn] of cases) {
    for (let i = 0; i < 10; i += 1) fn();
    warm[name] = measure(fn, iterations);
  }
  maybeGc();
  const mem = process.memoryUsage();
  store.close();
  return {
    cold: { recent100Ms: coldRecentMs, sinceNearMs: coldSinceMs },
    warm,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external },
  };
}

function makeConfig(dir) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    tokenFile: path.join(dir, "token.txt"),
    logDir: path.join(dir, "logs"),
    topics: ["ctf", "src", "daily", "sys"],
    ratePerMin: 1_000_000,
    bodyLimit: 64 * 1024,
    sseMax: 60,
    replayMax: 1000,
    retentionDays: 2,
    allowedCidrs: ["127.0.0.1/32", "::1/128"],
    logMaxBytes: 10 * 1024 * 1024,
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

function request(base, pathname, { method = "GET", token, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const start = process.hrtime.bigint();
    const req = http.request(
      new URL(pathname, base),
      { method, headers, agent },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            elapsedMs: msSince(start),
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runConcurrent(tasks, concurrency) {
  let next = 0;
  const results = [];
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function openSse(base, token, query) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      new URL(`/stream${query}`, base),
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE status ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        let text = "";
        const waiters = [];
        const notify = () => {
          for (const waiter of [...waiters]) {
            if (waiter.predicate(text)) {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              clearTimeout(waiter.timer);
              waiter.resolve(text);
            }
          }
        };
        res.on("data", (chunk) => {
          text += chunk;
          notify();
        });
        res.on("close", () => {
          for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("SSE closed"));
          }
        });
        resolve({
          text: () => text,
          waitFor(predicate, timeoutMs = 10_000) {
            if (predicate(text)) return Promise.resolve(text);
            return new Promise((resolveWait, rejectWait) => {
              const waiter = {
                predicate,
                resolve: resolveWait,
                reject: rejectWait,
                timer: setTimeout(() => {
                  const index = waiters.indexOf(waiter);
                  if (index >= 0) waiters.splice(index, 1);
                  rejectWait(new Error(`SSE timeout; tail=${text.slice(-200)}`));
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

async function httpBench(dir, total, iterations, clients) {
  const config = makeConfig(dir);
  const hub = createHub(config);
  const base = await listen(hub);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const token = hub.token;
  const readCases = [
    ["messages50", "/messages?limit=50"],
    ["messagesCtf100", "/messages?limit=100&topic=ctf"],
    ["sinceNear200", `/since/${Math.max(0, total - 200)}?limit=200`],
    ["since0_1000", "/since/0?limit=1000"],
  ];
  const sequential = {};
  for (const [name, pathname] of readCases) {
    for (let i = 0; i < 10; i += 1) await request(base, pathname, { token, agent });
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      const response = await request(base, pathname, { token, agent });
      samples.push(response.elapsedMs);
    }
    sequential[name] = statSummary(samples);
  }

  const concurrent = {};
  for (const [name, pathname] of readCases) {
    const tasks = Array.from({ length: Math.max(100, iterations) }, () => () =>
      request(base, pathname, { token, agent }).then((r) => r.elapsedMs),
    );
    concurrent[name] = statSummary(await runConcurrent(tasks, 10));
  }

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const pressureStart = process.hrtime.bigint();
  const pressureTasks = Array.from({ length: Math.max(200, iterations * 2) }, () => () =>
    request(base, readCases[0][1], { token, agent }),
  );
  await runConcurrent(pressureTasks, 10);
  const pressureMs = msSince(pressureStart);
  delay.disable();
  const eventLoop = {
    p99Ms: delay.percentile(99) / 1e6,
    maxMs: delay.max / 1e6,
    pressureMs,
  };

  let replay = null;
  let replayConcurrent = null;
  let fanout = null;
  const lastId = total;
  if (clients > 0) {
    const replaySamples = [];
    for (let i = 0; i < 10; i += 1) {
      const start = process.hrtime.bigint();
      const client = await openSse(base, token, `?since=${Math.max(0, lastId - 1000)}`);
      await client.waitFor((text) => text.includes(`\nid: ${lastId}\n`));
      replaySamples.push(msSince(start));
      client.close();
    }
    replay = statSummary(replaySamples);

    const concurrentReplay = Array.from({ length: clients }, async () => {
      const start = process.hrtime.bigint();
      const client = await openSse(base, token, `?since=${Math.max(0, lastId - 1000)}`);
      await client.waitFor((text) => text.includes(`\nid: ${lastId}\n`), 20_000);
      const elapsed = msSince(start);
      client.close();
      return elapsed;
    });
    replayConcurrent = statSummary(await Promise.all(concurrentReplay));

    const streamers = [];
    for (let i = 0; i < clients; i += 1) {
      const client = await openSse(base, token, `?since=${lastId}`);
      await client.waitFor((text) => text.includes("retry: 3000"));
      streamers.push(client);
    }
    const fanoutSamples = [];
    for (let i = 0; i < 20; i += 1) {
      const currentLast = hub.store.lastId;
      const start = process.hrtime.bigint();
      const sent = await request(base, "/send", {
        method: "POST",
        token,
        agent,
        body: { from: "cc", to: "all", topic: "daily", body: `fanout ${i} ${"x".repeat(160)}` },
      });
      if (sent.status !== 201) throw new Error(`send status ${sent.status}`);
      const id = sent.json().message.id;
      await Promise.all(
        streamers.map((client) =>
          client.waitFor((text) => text.includes(`\nid: ${id}\n`), 10_000),
        ),
      );
      fanoutSamples.push(msSince(start));
      if (hub.store.lastId <= currentLast) throw new Error("last id did not advance");
    }
    fanout = statSummary(fanoutSamples);
    for (const client of streamers) client.close();
  }

  const sendSamples = [];
  for (let i = 0; i < Math.min(100, iterations); i += 1) {
    const start = process.hrtime.bigint();
    const response = await request(base, "/send", {
      method: "POST",
      token,
      agent,
      body: { from: "dsh", to: "all", topic: "sys", body: `send bench ${i}` },
    });
    if (response.status !== 201) throw new Error(`send status ${response.status}`);
    sendSamples.push(msSince(start));
  }
  const send = statSummary(sendSamples);

  agent.destroy();
  await hub.close();
  maybeGc();
  const mem = process.memoryUsage();
  return {
    base,
    sequential,
    concurrent,
    eventLoop,
    replay,
    replayConcurrent,
    fanout,
    send,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external },
  };
}

function pct(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return ((a - b) / b) * 100;
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function printReport(report, baseline) {
  const rows = [];
  const add = (name, value, target, base) => {
    rows.push({
      metric: name,
      value: value === null || value === undefined ? "-" : Number(value).toFixed(2),
      target: target === null || target === undefined ? "-" : String(target),
      delta: baseline ? (pct(value, base) === null ? "-" : `${pct(value, base).toFixed(1)}%`) : "-",
    });
  };
  const b = baseline?.store?.warm || {};
  add("store.recent50.p95", report.store?.warm?.recent50?.p95, "<= 2/5ms", b.recent50?.p95);
  add("store.recentSys50.p95", report.store?.warm?.recentSys50?.p95, "<= 2/5ms", b.recentSys50?.p95);
  add("store.sinceNear200.p95", report.store?.warm?.sinceNear200?.p95, "<= 2/5ms", b.sinceNear200?.p95);
  add("store.since0_1000.p95", report.store?.warm?.since0_1000?.p95, "-", b.since0_1000?.p95);
  const h = report.http?.sequential || {};
  const hb = baseline?.http?.sequential || {};
  add("http.messages50.p95", h.messages50?.p95, "<= 10ms", hb.messages50?.p95);
  add("http.sinceNear200.p95", h.sinceNear200?.p95, "<= 10ms", hb.sinceNear200?.p95);
  add("http.since0_1000.p95", h.since0_1000?.p95, "-", hb.since0_1000?.p95);
  add("http.messages50.p99", h.messages50?.p99, "<= 25ms", hb.messages50?.p99);
  add("http.eventLoop.p99", report.http?.eventLoop?.p99Ms, "<= 20ms", baseline?.http?.eventLoop?.p99Ms);
  add("sse.replay.p95", report.http?.replay?.p95, "<= 50ms", baseline?.http?.replay?.p95);
  add("sse.replayConcurrent.p95", report.http?.replayConcurrent?.p95, "-", baseline?.http?.replayConcurrent?.p95);
  add("sse.fanout.p95", report.http?.fanout?.p95, "<= 20ms", baseline?.http?.fanout?.p95);
  add("send.p95", report.http?.send?.p95, "no >20% regression", baseline?.http?.send?.p95);
  add("rss.MB", (report.http?.memory?.rss || 0) / 1024 / 1024, "<= 180MB", null);
  console.table(rows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-perf-"));
  const dataDir = path.join(root, "data");
  try {
    const fixture = createFixture(dataDir, args.size, args.bodyBytes);
    const modes = new Set(args.modes.split(",").map((s) => s.trim()).filter(Boolean));
    const report = {
      generatedAt: new Date().toISOString(),
      node: NODE,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus()?.[0]?.model || "unknown",
      size: args.size,
      bodyBytes: args.bodyBytes,
      iterations: args.iterations,
      clients: args.clients,
      fixture,
    };
    if (modes.has("store")) report.store = storeBench(dataDir, args.size, args.iterations);
    if (modes.has("http") || modes.has("sse") || modes.has("send")) {
      report.http = await httpBench(dataDir, args.size, args.iterations, args.clients);
    }
    printReport(report, args.baseline ? loadJson(args.baseline) : null);
    if (args.json) {
      fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
      fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`wrote ${args.json}`);
    }
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* temp cleanup is best effort */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
