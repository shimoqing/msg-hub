#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createHub } from "../lib/hub.js";

function parseArgs(argv) {
  const out = {
    messages: 1000,
    steady: 50,
    burst: 1000,
    json: "",
    check: false,
    browser: process.env.MSGHUB_BROWSER || "",
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
      case "--messages":
        out.messages = Number(next());
        break;
      case "--steady":
        out.steady = Number(next());
        break;
      case "--burst":
        out.burst = Number(next());
        break;
      case "--json":
        out.json = next();
        break;
      case "--check":
        out.check = true;
        break;
      case "--browser":
        out.browser = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
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

function browserPath(explicit) {
  const candidates = [
    explicit,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function makeConfig(dir) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    tokenFile: path.join(dir, "data", "token.txt"),
    logDir: path.join(dir, "data", "logs"),
    topics: ["ctf", "src", "daily", "sys"],
    ratePerMin: 1_000_000,
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
    const onError = (err) => reject(err);
    hub.server.once("error", onError);
    hub.server.listen(0, "127.0.0.1", () => {
      hub.server.off("error", onError);
      resolve(`http://127.0.0.1:${hub.server.address().port}`);
    });
  });
}

async function launchBrowser(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-chrome-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1200,900",
    "about:blank",
  ];
  const child = spawn(browser, args, { stdio: "ignore", windowsHide: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  const portText = await waitFor(
    () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8") : ""),
    15_000,
    "DevToolsActivePort",
  );
  const port = Number(String(portText).split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("bad DevToolsActivePort");
  const targets = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (!response.ok) return null;
        const list = await response.json();
        return list.find((item) => item.type === "page") || null;
      } catch {
        return null;
      }
    },
    15_000,
    "page target",
  );
  return { child, profile, port, target: targets };
}

function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const events = new Map();
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString();
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { resolve: resolveCall, reject: rejectCall } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rejectCall(new Error(message.error.message || "CDP error"));
        else resolveCall(message.result);
        return;
      }
      if (message.method) {
        const listeners = events.get(message.method);
        if (listeners) for (const listener of listeners) listener(message.params);
      }
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          pending.set(id, { resolve: resolveCall, reject: rejectCall });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({
        send,
        on(method, listener) {
          if (!events.has(method)) events.set(method, new Set());
          events.get(method).add(listener);
        },
        close() {
          ws.close();
        },
      });
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(description || "evaluation failed");
  }
  return result.result?.value;
}

async function waitForPage(cdp, expression, label, timeoutMs = 15_000) {
  return waitFor(async () => {
    try {
      return await evaluate(cdp, expression);
    } catch {
      return false;
    }
  }, timeoutMs, label);
}

function seedExpression(count) {
  return `(() => {
    state.messages.length = 0;
    state.byId.clear();
    state.lastId = 0;
    state.unread.clear();
    state.loaded.clear();
    state.activeTopic = "all";
    state.autoScroll = true;
    const topics = ["ctf", "src", "daily", "sys"];
    const now = Date.now();
    for (let i = 1; i <= ${count}; i += 1) {
      addMessage({
        id: i,
        ts: new Date(now - ((i * 977) % 3600000)).toISOString(),
        from: i % 5 === 0 ? "me" : "cc",
        to: "all",
        topic: topics[i % topics.length],
        type: i % 20 === 0 ? "sys" : "chat",
        body: "消息 " + i + " " + "x".repeat(40),
        reply_to: null,
      });
    }
    state.lastId = ${count};
    render();
    return state.messages.length;
  })()`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = browserPath(args.browser);
  if (!browser) {
    console.error("no Chrome/Edge found; set MSGHUB_BROWSER or --browser");
    process.exitCode = 2;
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-ui-bench-"));
  const config = makeConfig(root);
  const hub = createHub(config);
  const base = await listen(hub);
  const browserInfo = await launchBrowser(browser);
  const cdp = await createCdp(browserInfo.target.webSocketDebuggerUrl);
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    browser,
    messages: args.messages,
    steady: args.steady,
    burst: args.burst,
  };
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Performance.enable");
    // Make programmatic scrolls deterministic; the page has a reduced-motion query.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await cdp.send("Page.navigate", { url: `${base}/` });
    await waitForPage(cdp, `document.readyState === "complete" && typeof state !== "undefined"`, "app boot");
    await waitForPage(cdp, "state.connected === true", "SSE connection", 5000).catch(() => false);

    const seeded = await evaluate(cdp, seedExpression(args.messages));
    if (seeded !== args.messages) throw new Error(`seeded ${seeded} messages`);

    const fullRender = await evaluate(cdp, `(() => {
      const samples = [];
      for (let i = 0; i < 30; i += 1) {
        const start = performance.now();
        render();
        document.body.offsetHeight;
        samples.push(performance.now() - start);
      }
      return samples;
    })()`);
    report.fullRender = statSummary(fullRender);

    const steadyTrue = await evaluate(cdp, `(async () => {
      state.autoScroll = true;
      const times = [];
      const now = Date.now();
      for (let i = 0; i < ${args.steady}; i += 1) {
        const message = {
          id: ${args.messages + 10_000} + i,
          ts: new Date(now + i * 1000).toISOString(),
          from: "cc", to: "all", topic: "daily", type: "chat",
          body: "steady " + i, reply_to: null,
        };
        const start = performance.now();
        onMessage(message);
        document.body.offsetHeight;
        times.push(performance.now() - start);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return times;
    })()`);
    report.steadyAutoScroll = statSummary(steadyTrue);

    await evaluate(cdp, seedExpression(args.messages));
    const steadyFalse = await evaluate(cdp, `(async () => {
      state.autoScroll = false;
      el.messages.scrollTop = 0;
      const times = [];
      const now = Date.now();
      for (let i = 0; i < ${args.steady}; i += 1) {
        const message = {
          id: ${args.messages + 20_000} + i,
          ts: new Date(now + i * 1000).toISOString(),
          from: "cc", to: "all", topic: "daily", type: "chat",
          body: "steady-off " + i, reply_to: null,
        };
        const start = performance.now();
        onMessage(message);
        document.body.offsetHeight;
        times.push(performance.now() - start);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return times;
    })()`);
    report.steadyNoAutoScroll = statSummary(steadyFalse);

    await evaluate(cdp, seedExpression(args.messages));
    const metricsBefore = await cdp.send("Performance.getMetrics");
    const burst = await evaluate(cdp, `(async () => {
      const longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
      const start = performance.now();
      const now = Date.now();
      for (let i = 0; i < ${args.burst}; i += 1) {
        onMessage({
          id: ${args.messages + 30_000} + i,
          ts: new Date(now + i * 1000).toISOString(),
          from: "cc", to: "all", topic: "daily", type: "chat",
          body: "burst " + i, reply_to: null,
        });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.body.offsetHeight;
      for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
      observer.disconnect();
      return { total: performance.now() - start, longTasks };
    })()`);
    const metricsAfter = await cdp.send("Performance.getMetrics");
    report.burstMs = burst.total;
    report.burstLongTasks = burst.longTasks;
    const toMap = (result) => Object.fromEntries(result.metrics.map((m) => [m.name, m.value]));
    const beforeMap = toMap(metricsBefore);
    const afterMap = toMap(metricsAfter);
    report.burstMetrics = {};
    for (const key of [
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "LayoutCount",
      "RecalcStyleCount",
      "Nodes",
      "JSEventListeners",
      "JSHeapUsedSize",
    ]) {
      report.burstMetrics[key] = (afterMap[key] || 0) - (beforeMap[key] || 0);
    }

    const warmSwitch = await evaluate(cdp, `(async () => {
      const start = performance.now();
      await switchRoom("ctf");
      return performance.now() - start;
    })()`);
    const warmSwitchBack = await evaluate(cdp, `(async () => {
      const start = performance.now();
      await switchRoom("all");
      return performance.now() - start;
    })()`);
    report.roomSwitch = { ctfMs: warmSwitch, allMs: warmSwitchBack };

    const invariants = await evaluate(cdp, `(async () => {
      state.autoScroll = true;
      el.messages.scrollTop = el.messages.scrollHeight;
      const beforeNodes = [...el.messages.querySelectorAll(".msg")];
      const beforeVisible = state.messages.filter((m) => state.activeTopic === "all" || m.topic === state.activeTopic);
      // Mark the newest node: appending must survive, while the oldest is legitimately evicted at the 1000 cap.
      const marked = beforeNodes[beforeNodes.length - 1];
      if (marked) marked.dataset.marker = "keep";
      onMessage({
        id: 999999,
        ts: new Date().toISOString(),
        from: "cc", to: "all", topic: "daily", type: "chat",
        body: "marker check", reply_to: null,
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.body.offsetHeight;
      const nodes = [...el.messages.querySelectorAll(".msg")];
      const ids = nodes.map((node) => Number(node.id.replace("m-", "")));
      const visible = state.messages.filter((m) => state.activeTopic === "all" || m.topic === state.activeTopic);
      return {
        nodeCount: nodes.length,
        visibleCount: visible.length,
        countMatches: nodes.length === visible.length,
        countMatchesBefore: beforeNodes.length === beforeVisible.length,
        unique: new Set(ids).size === ids.length,
        ascending: ids.every((id, index) => index === 0 || id > ids[index - 1]),
        dayDividers: el.messages.querySelectorAll(".day").length,
        emptyAbsent: !el.messages.querySelector(".empty"),
        markerSurvived: Boolean(el.messages.querySelector('[data-marker="keep"]')),
        atBottom: Math.abs(el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight) < 3,
      };
    })()`);
    report.invariants = invariants;

    console.table([
      { metric: "fullRender.p95", value: report.fullRender.p95.toFixed(2), unit: "ms" },
      { metric: "steadyAutoScroll.p95", value: report.steadyAutoScroll.p95.toFixed(2), unit: "ms" },
      { metric: "steadyNoAutoScroll.p95", value: report.steadyNoAutoScroll.p95.toFixed(2), unit: "ms" },
      { metric: `${args.burst} burst`, value: report.burstMs.toFixed(2), unit: "ms" },
      { metric: "switch ctf", value: report.roomSwitch.ctfMs.toFixed(2), unit: "ms" },
      { metric: "switch all", value: report.roomSwitch.allMs.toFixed(2), unit: "ms" },
    ]);
    console.log("invariants", report.invariants);
    console.log("burst metrics", report.burstMetrics);
    console.log("burst long tasks", report.burstLongTasks);

    if (args.check) {
      const ok =
        invariants.countMatches &&
        invariants.unique &&
        invariants.ascending &&
        invariants.emptyAbsent &&
        invariants.markerSurvived &&
        report.steadyAutoScroll.p95 <= 16 &&
        report.steadyAutoScroll.max <= 32 &&
        report.burstMs <= 500 &&
        report.burstLongTasks.every((duration) => duration <= 200);
      if (!ok) {
        console.error("UI check failed");
        process.exitCode = 1;
      }
    }
    if (args.json) {
      fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
      fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`wrote ${args.json}`);
    }
  } finally {
    cdp.close();
    await hub.close();
    browserInfo.child.kill();
    try {
      fs.rmSync(browserInfo.profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
