import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "./log.js";
import { createSseHub } from "./sse.js";
import { createPresence } from "./presence.js";
import { Store, acquireLock } from "./store.js";
import { IDENTITY_RE, MESSAGE_TYPES, FILE_ID_RE } from "./protocol.js";
import { VERSION } from "./version.js";
import { ensureToken, isAuthorized, createRateLimiter, isAddressAllowed } from "./auth.js";
import {
  intParam,
  readJsonBody,
  readRawBody,
  sendError,
  sendJson,
  sendMethodNotAllowed,
  sendNotFound,
  sendTooLarge,
  sendUnauthorized,
  serveStatic,
} from "./http.js";
import { createFileStore } from "./files.js";
import { createAgentRegistry } from "./agents.js";
import { createGroupRegistry } from "./groups.js";
import { createPlanRegistry } from "./plans.js";
import { createProfileStore } from "./profile.js";
import { createContextStore } from "./contexts.js";
import { createLauncher } from "./launcher.js";
import { PRESETS, getPreset, renderCommand } from "./presets.js";
import { isLoopback } from "./http.js";

const PRESENCE_POST_PER_MIN = 120;
const PRESENCE_BODY_LIMIT = 512;
const FILE_UPLOAD_PER_MIN = 60;
const REGISTRY_WRITE_PER_MIN = 120;
const NOTE_MAX_CHARS = 2000;

function contentDisposition(name) {
  // filename= fallback is ASCII-only; filename* carries UTF-8 names.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function validReadTo(to) {
  return to === null || IDENTITY_RE.test(to);
}

function parseFileBody(body, files) {
  let ref;
  try {
    ref = JSON.parse(body);
  } catch {
    return { error: "file body must be a JSON object" };
  }
  if (!ref || typeof ref !== "object" || !FILE_ID_RE.test(ref.id ?? "")) {
    return { error: "file body must reference an uploaded file id" };
  }
  const stored = files.get(ref.id);
  if (!stored) return { error: "file body must reference an uploaded file id" };
  for (const field of ["name", "size", "sha256"]) {
    if (ref[field] !== undefined && ref[field] !== stored[field]) {
      return { error: `file ${field} does not match the uploaded record` };
    }
    ref[field] = stored[field];
  }
  if (ref.note !== undefined && (typeof ref.note !== "string" || ref.note.length > NOTE_MAX_CHARS)) {
    return { error: "file note must be plain text of at most 2000 characters" };
  }
  ref.note = ref.note ?? "";
  return { ref };
}

export function createHub(config) {
  const logger = createLogger({
    logDir: config.logDir,
    maxBytes: config.logMaxBytes,
    prefix: "hub",
  });

  let lock;
  try {
    lock = acquireLock(config.dataDir);
  } catch (err) {
    logger.close();
    throw err;
  }

  let token;
  let store;
  try {
    token = ensureToken(config.tokenFile);
    store = new Store({
      dataDir: config.dataDir,
      retentionDays: config.retentionDays,
      bodyLimit: config.bodyLimit,
      maxCacheBytes: config.cacheMaxBytes,
      maxCacheMessages: config.cacheMaxMessages,
      logger,
    }).init();
  } catch (err) {
    lock.release();
    logger.close();
    throw err;
  }

  const presence = createPresence();
  const sse = createSseHub({
    maxClients: config.sseMax,
    logger,
    onAttach: (client) => presence.attach(client.identity),
    onDetach: (client) => presence.detach(client.identity),
    onHeartbeat: (client) => presence.heartbeat(client.identity),
  });
  const limiter = createRateLimiter({ perMin: config.ratePerMin });
  const presenceLimiter = createRateLimiter({ perMin: PRESENCE_POST_PER_MIN });
  const uploadLimiter = createRateLimiter({ perMin: FILE_UPLOAD_PER_MIN });

  let files;
  try {
    files = createFileStore({
      dir: path.join(config.dataDir, "files"),
      maxBytes: config.filesMaxBytes,
      logger,
    });
  } catch (err) {
    store.close();
    lock.release();
    logger.close();
    throw err;
  }

  let agents;
  let groups;
  let plans;
  let profile;
  let contexts;
  let launcher;
  const registryPath = (key, name) => config[key] ?? path.join(config.dataDir, name);
  try {
    const registryOpts = { logger, now: () => new Date().toISOString() };
    agents = createAgentRegistry({ file: registryPath("agentsFile", "agents.jsonl"), ...registryOpts });
    groups = createGroupRegistry({ file: registryPath("groupsFile", "groups.jsonl"), configTopics: config.topics, ...registryOpts });
    plans = createPlanRegistry({ file: registryPath("plansFile", "plans.jsonl"), ...registryOpts });
    profile = createProfileStore({ file: registryPath("profileFile", "profile.jsonl"), ...registryOpts });
    contexts = createContextStore({ file: registryPath("contextsFile", "contexts.jsonl"), ...registryOpts });
    launcher = createLauncher({
      dataDir: config.dataDir,
      tokenFile: config.tokenFile,
      base: `http://127.0.0.1:${config.port}`,
      nodeBin: process.execPath,
      logger,
    });
  } catch (err) {
    store.close();
    lock.release();
    logger.close();
    throw err;
  }

  const registryLimiter = createRateLimiter({ perMin: REGISTRY_WRITE_PER_MIN });
  const eventClients = new Set();
  const sweepTimer = setInterval(() => {
    try {
      plans.sweep();
    } catch (err) {
      logger.error(`plan sweep failed: ${err.message}`);
    }
  }, 15_000);
  sweepTimer.unref?.();

  function broadcastEvent(type, id) {
    const payload = `data: ${JSON.stringify({ type, id: id ?? null, ts: new Date().toISOString() })}\n\n`;
    for (const res of [...eventClients]) {
      try {
        res.write(payload);
      } catch {
        eventClients.delete(res);
      }
    }
  }

  function validReadTopic(topic) {
    return topic === "all" || groups.canRead(topic);
  }

  function validWriteTopic(topic) {
    return typeof topic === "string" && groups.canWrite(topic);
  }

  // Shared send path: validate -> rate limit -> write+fsync -> broadcast ->
  // plan observation. /send and internal plan dispatch both go through here.
  // Order matters: the message is durable before anything can observe it.
  function sendMessage({ from, to, topic, type, body, reply_to, internal = false, rateLimit = true }) {
    if (!IDENTITY_RE.test(from)) throw Object.assign(new Error("invalid from"), { code: "BAD_INPUT" });
    if (to !== "all" && !IDENTITY_RE.test(to)) throw Object.assign(new Error("invalid to"), { code: "BAD_INPUT" });
    if (!validWriteTopic(topic)) throw Object.assign(new Error("invalid topic"), { code: "BAD_INPUT" });
    if (!MESSAGE_TYPES.has(type)) throw Object.assign(new Error("invalid type"), { code: "BAD_INPUT" });
    if (type === "plan" && !internal) throw Object.assign(new Error("plan_reserved"), { code: "BAD_INPUT" });
    if (typeof body !== "string" || body.length === 0) throw Object.assign(new Error("body is required"), { code: "BAD_INPUT" });
    if (Buffer.byteLength(body, "utf8") > config.bodyLimit) throw Object.assign(new Error("body too large"), { code: "TOO_LARGE" });
    if (reply_to !== null && reply_to !== undefined && (!Number.isInteger(reply_to) || reply_to <= 0)) {
      throw Object.assign(new Error("invalid reply_to"), { code: "BAD_INPUT" });
    }

    if (type === "file") {
      const parsed = parseFileBody(body, files);
      if (parsed.error) throw Object.assign(new Error(parsed.error), { code: "BAD_INPUT" });
      body = JSON.stringify(parsed.ref);
    }

    if (rateLimit) {
      const rate = limiter.check(from);
      if (!rate.allowed) throw Object.assign(new Error("rate_limited"), { code: "RATE_LIMITED", retryAfter: rate.retryAfter });
    }

    const message = store.append({ from, to, topic, type, body, reply_to: reply_to ?? null });
    sse.broadcast(message);
    try {
      plans.observe(message);
    } catch (err) {
      logger.error(`plan observe failed: ${err.message}`);
    }
    return message;
  }

  function agentView(agent) {
    if (!agent) return null;
    const presenceList = presence.snapshot();
    const p = presenceList.find((item) => item.identity === agent.id);
    const runtime = launcher.status(agent.id);
    return {
      ...agent,
      online: Boolean(p?.online),
      presence_state: p?.state ?? "offline",
      last_seen: p?.last_seen ?? null,
      runtime: runtime ?? null,
    };
  }

  function statePayload() {
    const observed = new Set();
    for (const message of store.recent({ limit: 500 }).messages) {
      if (IDENTITY_RE.test(message.from)) observed.add(message.from);
      if (message.to !== "all" && IDENTITY_RE.test(message.to)) observed.add(message.to);
    }
    for (const p of presence.snapshot()) observed.add(p.identity);
    const agentsList = agents.all().map((a) => agentView(a));
    const known = new Set(agentsList.map((a) => a.id));
    for (const id of observed) {
      if (known.has(id)) continue;
      agentsList.push(agentView({ id, kind: "agent", name: id, source: "observed", enabled: true, launch: { mode: "manual", auto_start: false } }));
    }
    return {
      ok: true,
      profile: profile.get(),
      agents: agentsList,
      groups: groups.all(),
      plans: plans.all().map((p) => plans.summary(p)),
      server: { version: VERSION, port: config.port, topics: config.topics, now: new Date().toISOString() },
    };
  }

  function requireRegistryLimit(res, key) {
    const rate = registryLimiter.check(key);
    if (rate.allowed) return true;
    sendError(res, 429, "rate_limited", "too many registry writes", { "Retry-After": String(rate.retryAfter) });
    return false;
  }

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method || "GET";
    const remoteAddress = req.socket.remoteAddress;

    res.on("finish", () => {
      logger.info(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (!isAddressAllowed(remoteAddress, config.allowedCidrs)) {
      sendError(res, 403, "forbidden_ip", "source address is not allowed");
      return;
    }

    if (pathname === "/health") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        service: "msg-hub",
        version: VERSION,
        uptime_s: Math.round(process.uptime()),
        last_id: store.lastId,
        sse_clients: sse.size,
      });
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/" || pathname === "/app.js" || pathname === "/style.css") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      serveStatic(req, res, {
        urlPath: pathname,
        token,
        publicDir: PUBLIC_DIR,
        remoteAddress,
      });
      return;
    }

    if (!isAuthorized(req, url, token)) {
      sendUnauthorized(res);
      return;
    }

    // ---- v0.4 state / registries -----------------------------------------

    if (pathname === "/state") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      sendJson(res, 200, statePayload());
      return;
    }

    if (pathname === "/events") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      res.write("retry: 3000\n\n");
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return;
    }

    if (pathname === "/profile") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, profile: profile.get() });
        return;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 4096 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, "profile")) return;
      let saved;
      try {
        saved = profile.upsert(payload);
        // First profile write also creates the human agent record.
        const operator = saved.operator;
        if (!agents.has(operator)) {
          agents.upsert({
            id: operator,
            kind: "human",
            name: saved.display_name,
            role: "操作者",
            backend: "custom",
            capabilities: ["none"],
            avatar_hue: saved.avatar_hue ?? 18,
          });
        }
      } catch (err) {
        sendError(res, 400, "bad_request", err.message);
        return;
      }
      broadcastEvent("profile", null);
      sendJson(res, 200, { ok: true, profile: saved });
      return;
    }

    if (pathname === "/agents/presets") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const node = process.execPath;
      const base = `http://127.0.0.1:${config.port}`;
      sendJson(res, 200, {
        ok: true,
        presets: PRESETS.map((p) => ({
          ...p,
          command: renderCommand(p, { base, tokenFile: config.tokenFile, node }),
        })),
      });
      return;
    }

    if (pathname === "/agents/register") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 4096 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, "register")) return;
      let agent;
      try {
        agent = agents.observe({
          id: payload.id,
          backend: payload.backend,
          model: payload.model,
          capabilities: payload.capabilities,
          version: payload.version,
          last_seen: new Date().toISOString(),
        });
      } catch (err) {
        sendError(res, 400, "bad_request", err.message);
        return;
      }
      broadcastEvent("agents", agent.id);
      sendJson(res, 200, { ok: true, agent: agentView(agent) });
      return;
    }

    if (pathname === "/agents") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, agents: statePayload().agents });
        return;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 8192 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, "agents")) return;
      let agent;
      try {
        agent = agents.upsert(payload);
      } catch (err) {
        sendError(res, 400, "bad_request", err.message);
        return;
      }
      broadcastEvent("agents", agent.id);
      sendJson(res, 200, { ok: true, agent: agentView(agent) });
      return;
    }

    const contextMatch = /^\/agents\/([a-z0-9_-]+)\/context$/.exec(pathname);
    if (contextMatch) {
      const id = contextMatch[1];
      if (method === "POST") {
        let payload;
        try {
          payload = await readJsonBody(req, { limit: 8192 });
        } catch {
          sendError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        if (!requireRegistryLimit(res, `context:${id}`)) return;
        try {
          contexts.append({ ...payload, agent: id });
        } catch (err) {
          sendError(res, 400, "bad_request", err.message);
          return;
        }
        broadcastEvent("contexts", id);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "GET") {
        const limit = intParam(url, "limit", 20, 1, 200);
        const records = contexts.list(id, limit);
        const resolved = records.map((record) => {
          const ctx = record.context;
          const byId = new Map(store.recent({ limit: 1000 }).messages.map((m) => [m.id, m]));
          const messageOf = (mid) => {
            const m = byId.get(mid);
            if (!m) return null;
            return { id: m.id, from: m.from, type: m.type, body: m.body, ts: m.ts, topic: m.topic };
          };
          const filesOf = (ids) =>
            ids.map((fid) => {
              const rec = files.get(fid);
              return rec ? { id: rec.id, name: rec.name, size: rec.size, sha256: rec.sha256, note: null } : { id: fid, missing: true };
            });
          return {
            ...ctx,
            trigger: messageOf(ctx.trigger_message_id),
            included: ctx.included_message_ids.map(messageOf).filter(Boolean),
            files: filesOf(ctx.file_ids),
            reply: ctx.reply_message_id ? messageOf(ctx.reply_message_id) : null,
          };
        });
        sendJson(res, 200, { ok: true, records: resolved, reported: resolved.length > 0 });
        return;
      }
      sendMethodNotAllowed(res, "GET, POST");
      return;
    }

    const connectMatch = /^\/agents\/([a-z0-9_-]+)\/(connect|disconnect)$/.exec(pathname);
    if (connectMatch) {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const [, id, action] = connectMatch;
      if (!isLoopback(remoteAddress)) {
        sendError(res, 403, "forbidden_ip", "connect is only available from loopback");
        return;
      }
      if (!requireRegistryLimit(res, `connect:${id}`)) return;
      try {
        const result = action === "connect"
          ? launcher.start(id, { loopback: true })
          : launcher.stop(id);
        if (action === "connect") {
          const agent = agents.get(id);
          const preset = getPreset(id);
          if (agent && preset) {
            agents.upsert({
              id,
              launch: { mode: "local", preset: preset.id, auto_start: false },
            });
          }
        }
        broadcastEvent("agents", id);
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        const status = err.code === "CONFLICT" ? 409 : err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 400;
        sendError(res, status, status === 403 ? "forbidden_ip" : status === 404 ? "not_found" : "bad_request", err.message);
      }
      return;
    }

    const agentById = /^\/agents\/([a-z0-9_-]+)$/.exec(pathname);
    if (agentById) {
      const id = agentById[1];
      if (method === "GET") {
        const agent = agents.get(id);
        if (!agent) {
          sendNotFound(res);
          return;
        }
        sendJson(res, 200, { ok: true, agent: agentView(agent) });
        return;
      }
      if (method === "DELETE") {
        if (!requireRegistryLimit(res, `agents:${id}`)) return;
        agents.remove(id);
        broadcastEvent("agents", id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendMethodNotAllowed(res, "GET, DELETE");
      return;
    }

    if (pathname === "/groups") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, groups: groups.all() });
        return;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 8192 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, "groups")) return;
      let group;
      try {
        group = groups.create(payload);
      } catch (err) {
        sendError(res, err.code === "CONFLICT" ? 409 : 400, "bad_request", err.message);
        return;
      }
      broadcastEvent("groups", group.id);
      sendJson(res, 201, { ok: true, group });
      return;
    }

    const groupById = /^\/groups\/([a-z0-9_-]+)$/.exec(pathname);
    if (groupById) {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 8192 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, `groups:${groupById[1]}`)) return;
      try {
        const group = groups.update(groupById[1], payload);
        broadcastEvent("groups", group.id);
        sendJson(res, 200, { ok: true, group });
      } catch (err) {
        sendError(res, err.code === "NOT_FOUND" ? 404 : 400, "bad_request", err.message);
      }
      return;
    }

    if (pathname === "/plans") {
      if (method === "GET") {
        const topic = url.searchParams.get("group");
        const list = plans.all()
          .filter((p) => !topic || p.group === topic)
          .map((p) => plans.summary(p));
        sendJson(res, 200, { ok: true, plans: list });
        return;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, { limit: 8192 });
      } catch {
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }
      if (!requireRegistryLimit(res, "plans")) return;
      if (!validWriteTopic(payload.group)) {
        sendError(res, 400, "bad_request", "invalid group");
        return;
      }
      const group = groups.get(payload.group);
      // Legacy seeded topics have no explicit member list (they predate the
      // registry); only enforce membership on groups the user actually created.
      if (group && group.members.length > 0 && group.kind !== "dm") {
        for (const step of payload.steps ?? []) {
          if (!group.members.includes(step.assignee)) {
            sendError(res, 400, "bad_request", `assignee ${step.assignee} is not a group member`);
            return;
          }
        }
      }
      let plan;
      try {
        // Validate first, then allocate the id, then write the timeline card
        // with the SAME id that the projection will use.
        plan = plans.create(payload);
        const card = sendMessage({
          from: plan.created_by,
          to: "all",
          topic: plan.group,
          type: "plan",
          body: JSON.stringify({ plan_id: plan.plan_id }),
          internal: true,
          rateLimit: false,
        });
        // The card id is metadata on the plan; persist it as an update event.
        plans.updateCard(plan.plan_id, card.id);
        broadcastEvent("plans", plan.plan_id);
      } catch (err) {
        sendError(res, 400, "bad_request", err.message);
        return;
      }
      sendJson(res, 201, { ok: true, plan: plans.summary(plan) });
      return;
    }

    const planAction = /^\/plans\/(p-[a-f0-9]{8})\/(start|next|retry|stop|assign|complete)$/.exec(pathname);
    if (planAction) {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const [, id, action] = planAction;
      if (!requireRegistryLimit(res, `plans:${id}`)) return;
      let payload = {};
      try {
        payload = await readJsonBody(req, { limit: 4096 });
      } catch {
        /* empty body is fine for stop/start */
      }
      try {
        let plan = plans.get(id);
        if (!plan) {
          sendNotFound(res);
          return;
        }
        if (action === "start") plan = plans.start(id);
        if (action === "stop") plan = plans.stop(id);
        if (action === "retry") plan = plans.retry(id, Number(payload.step ?? 1));
        if (action === "complete") {
          const step = plan.steps.find((s) => s.status === "running")?.n ?? Number(payload.step ?? 1);
          plan = plans.complete(id, step);
        }
        if (action === "assign") {
          const step = Number(payload.step ?? plan.steps.find((s) => s.status === "pending")?.n ?? 1);
          plan = plans.assign(id, step, payload.assignee);
        }
        if (action === "start" || action === "next" || action === "retry") {
          const step = plan.steps.find((s) => s.status === "pending")?.n
            ?? plan.steps.find((s) => s.status === "failed")?.n
            ?? null;
          if (step !== null) {
            const target = plan.steps.find((s) => s.n === step);
            const dispatch = sendMessage({
              from: plan.created_by,
              to: target.assignee,
              topic: plan.group,
              type: "chat",
              body: `[分工 ${id} 第 ${step} 步] @${target.assignee} ${target.task}`,
              reply_to: plan.card_message_id,
              internal: false,
              rateLimit: false,
            });
            plans.markStepStart(id, step, dispatch.id);
          }
        }
        broadcastEvent("plans", id);
        sendJson(res, 200, { ok: true, plan: plans.summary(plans.get(id)) });
      } catch (err) {
        sendError(res, err.code === "CONFLICT" ? 409 : err.code === "NOT_FOUND" ? 404 : 400, "bad_request", err.message);
      }
      return;
    }

    const planById = /^\/plans\/(p-[a-f0-9]{8})$/.exec(pathname);
    if (planById) {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const plan = plans.get(planById[1]);
      if (!plan) {
        sendNotFound(res);
        return;
      }
      sendJson(res, 200, { ok: true, plan });
      return;
    }

    if (pathname === "/admin/backup") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(config.dataDir, "backups", `msg-hub-${stamp}`);
      fs.mkdirSync(dir, { recursive: true });
      const manifest = { version: VERSION, created_at: new Date().toISOString(), files: [] };
      const names = ["agents.jsonl", "groups.jsonl", "plans.jsonl", "profile.jsonl", "contexts.jsonl"];
      for (const name of names) {
        const src = path.join(config.dataDir, name);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(dir, name));
          manifest.files.push(name);
        }
      }
      for (const name of fs.readdirSync(config.dataDir)) {
        if (/^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
          fs.copyFileSync(path.join(config.dataDir, name), path.join(dir, name));
          manifest.files.push(name);
        }
      }
      const filesDir = path.join(config.dataDir, "files");
      if (fs.existsSync(filesDir)) {
        fs.cpSync(filesDir, path.join(dir, "files"), { recursive: true });
        manifest.files.push("files/");
      }
      fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      sendJson(res, 201, { ok: true, path: dir, manifest });
      return;
    }

    if (pathname === "/send") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const contentType = req.headers["content-type"] || "";
      if (!/^application\/json\b/i.test(contentType)) {
        sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
        return;
      }

      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isInteger(declaredLength) && declaredLength > config.bodyLimit) {
        sendTooLarge(req, res, config.bodyLimit);
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req, { limit: config.bodyLimit });
      } catch (err) {
        if (err.code === "TOO_LARGE") {
          sendTooLarge(req, res, config.bodyLimit);
          return;
        }
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }

      const from = payload.from;
      if (typeof from !== "string" || !IDENTITY_RE.test(from)) {
        sendError(res, 400, "bad_request", "invalid from");
        return;
      }
      const to = payload.to ?? "all";
      if (typeof to !== "string" || (to !== "all" && !IDENTITY_RE.test(to))) {
        sendError(res, 400, "bad_request", "invalid to");
        return;
      }
      const topic = payload.topic ?? "daily";
      const type = payload.type ?? "chat";
      if (typeof topic !== "string" || !validWriteTopic(topic)) {
        sendError(res, 400, "bad_request", "invalid topic");
        return;
      }
      if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) {
        sendError(res, 400, "bad_request", "invalid type");
        return;
      }
      if (type === "plan") {
        sendError(res, 400, "plan_reserved", "plan messages are created by the hub");
        return;
      }
      if (typeof payload.body !== "string" || payload.body.length === 0) {
        sendError(res, 400, "bad_request", "body is required");
        return;
      }
      if (Buffer.byteLength(payload.body, "utf8") > config.bodyLimit) {
        sendError(res, 413, "too_large", "body field is too large");
        return;
      }
      if (type === "file") {
        const parsed = parseFileBody(payload.body, files);
        if (parsed.error) {
          sendError(res, 400, "bad_request", parsed.error);
          return;
        }
      }
      const replyTo = payload.reply_to ?? null;
      if (replyTo !== null && (!Number.isInteger(replyTo) || replyTo <= 0)) {
        sendError(res, 400, "bad_request", "invalid reply_to");
        return;
      }
      const rate = limiter.check(from);
      if (!rate.allowed) {
        sendError(res, 429, "rate_limited", "too many messages", {
          "Retry-After": String(rate.retryAfter),
        });
        return;
      }

      let message;
      try {
        // rateLimit=false: the check already happened above with the HTTP response shape.
        message = sendMessage({ from, to, topic, type, body: payload.body, reply_to: replyTo, rateLimit: false });
      } catch (err) {
        logger.error(`append failed: ${err.message}`);
        sendError(res, 500, "internal", "failed to persist message");
        return;
      }

      sendJson(res, 201, { ok: true, message });
      return;
    }

    if (pathname === "/messages") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const limit = intParam(url, "limit", 50, 1, 200);
      const topic = url.searchParams.get("topic") || "all";
      const to = url.searchParams.get("to") || null;
      if (!validReadTopic(topic) || !validReadTo(to)) {
        sendError(res, 400, "bad_request", "invalid topic or to");
        return;
      }
      const type = url.searchParams.get("type") || null;
      const result = store.recent({ limit, topic, to });
      const messages = type ? result.messages.filter((m) => m.type === type) : result.messages;
      sendJson(res, 200, { ok: true, messages, last_id: result.lastId });
      return;
    }

    const sinceMatch = /^\/since\/(\d+)$/.exec(pathname);
    if (sinceMatch) {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const id = Number(sinceMatch[1]);
      const limit = intParam(url, "limit", 200, 1, 1000);
      const topic = url.searchParams.get("topic") || "all";
      const to = url.searchParams.get("to") || null;
      if (!validReadTopic(topic) || !validReadTo(to)) {
        sendError(res, 400, "bad_request", "invalid topic or to");
        return;
      }
      const result = store.since(id, { topic, to, limit });
      sendJson(res, 200, {
        ok: true,
        messages: result.messages,
        last_id: result.lastId,
        oldest_available_id: result.oldestAvailableId,
      });
      return;
    }

    if (pathname === "/stream") {
      if (method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      if (sse.size >= config.sseMax) {
        sendError(res, 503, "too_many_clients", "too many SSE clients");
        return;
      }

      const topic = url.searchParams.get("topic") || "all";
      const to = url.searchParams.get("to") || null;
      if (!validReadTopic(topic) || !validReadTo(to)) {
        sendError(res, 400, "bad_request", "invalid topic or to");
        return;
      }

      const identity = url.searchParams.get("identity");
      if (identity !== null && !IDENTITY_RE.test(identity)) {
        sendError(res, 400, "bad_request", "invalid identity");
        return;
      }

      const headerLastId = req.headers["last-event-id"];
      const sinceRaw = headerLastId ?? url.searchParams.get("since");
      let fromId = null;
      if (sinceRaw !== undefined && sinceRaw !== null && String(sinceRaw).trim() !== "") {
        const parsed = Number(sinceRaw);
        if (Number.isInteger(parsed) && parsed >= 0) fromId = parsed;
      }

      const replay =
        fromId === null
          ? []
          : store.since(fromId, { topic, to, limit: config.replayMax }).messages;

      if (!sse.add(req, res, { topic, to, replay, identity })) {
        sendError(res, 503, "too_many_clients", "too many SSE clients");
      }
      return;
    }

    if (pathname === "/presence") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, identities: presence.snapshot() });
        return;
      }
      if (method !== "POST") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!/^application\/json\b/i.test(contentType)) {
        sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req, { limit: PRESENCE_BODY_LIMIT });
      } catch (err) {
        if (err.code === "TOO_LARGE") {
          sendError(res, 413, "too_large", "presence body is too large");
          return;
        }
        sendError(res, 400, "bad_request", "invalid JSON body");
        return;
      }

      const from = payload.from;
      if (typeof from !== "string" || !IDENTITY_RE.test(from)) {
        sendError(res, 400, "bad_request", "invalid from");
        return;
      }

      const state = payload.state ?? "online";
      if (state !== "online" && state !== "typing" && state !== "idle") {
        sendError(res, 400, "bad_request", "invalid state");
        return;
      }

      const rate = presenceLimiter.check(from);
      if (!rate.allowed) {
        sendError(res, 429, "rate_limited", "too many presence updates", {
          "Retry-After": String(rate.retryAfter),
        });
        return;
      }

      presence.touch(from, state);
      sendJson(res, 200, { ok: true });
      return;
    }

    // (?!upload$) keeps /files/upload out of the id route below.
    const filesMatch = /^\/files\/(?!upload$)([A-Za-z0-9_-]+)$/.exec(pathname);
    if (pathname === "/files" || filesMatch) {
      if (method === "GET" && pathname === "/files") {
        sendJson(res, 200, { ok: true, files: files.list() });
        return;
      }
      if (method === "POST" && pathname === "/files") {
        sendMethodNotAllowed(res, "GET, POST");
        return;
      }
      if (filesMatch) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        const rec = files.get(filesMatch[1]);
        if (!rec) {
          sendNotFound(res);
          return;
        }
        let bytes;
        try {
          bytes = fs.readFileSync(rec.abs);
        } catch {
          sendError(res, 410, "file_gone", "file bytes are missing on disk");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": bytes.length,
          "Content-Disposition": contentDisposition(rec.name),
          "Cache-Control": "no-store",
        });
        res.end(bytes);
        return;
      }
    }

    if (pathname === "/files/upload") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isInteger(declaredLength) && declaredLength > config.filesMaxBytes) {
        sendTooLarge(req, res, config.filesMaxBytes);
        return;
      }
      let bytes;
      try {
        bytes = await readRawBody(req, { limit: config.filesMaxBytes });
      } catch (err) {
        if (err.code === "TOO_LARGE") {
          sendTooLarge(req, res, config.filesMaxBytes);
          return;
        }
        sendError(res, 400, "bad_request", "failed to read upload");
        return;
      }
      const rawName = url.searchParams.get("name");
      if (rawName === null || rawName.trim() === "") {
        sendError(res, 400, "bad_request", "name is required");
        return;
      }
      const from = url.searchParams.get("from");
      const rateKey = from && IDENTITY_RE.test(from) ? from : `ip:${remoteAddress}`;
      const rate = uploadLimiter.check(rateKey);
      if (!rate.allowed) {
        sendError(res, 429, "rate_limited", "too many uploads", {
          "Retry-After": String(rate.retryAfter),
        });
        return;
      }
      let file;
      try {
        file = files.put({ name: rawName, bytes, by: from && IDENTITY_RE.test(from) ? from : null });
      } catch (err) {
        if (err.code === "TOO_LARGE") {
          sendTooLarge(req, res, config.filesMaxBytes);
          return;
        }
        logger.error(`file put failed: ${err.message}`);
        sendError(res, 500, "internal", "failed to store file");
        return;
      }
      logger.info(`file uploaded id=${file.id} size=${file.size} by=${file.by ?? "?"}`);
      sendJson(res, 201, { ok: true, file });
      return;
    }

    sendNotFound(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`request failed: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, 500, "internal", "internal server error");
      } else {
        res.destroy();
      }
    });
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  let closed = false;

  return {
    server,
    store,
    sse,
    logger,
    token,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      sse.close();
      for (const res of [...eventClients]) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      eventClients.clear();
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Do not let idle keep-alive sockets block shutdown forever.
        server.closeAllConnections?.();
      }).finally(() => {
        clearInterval(sweepTimer);
        launcher.stopAll();
        agents.close();
        groups.close();
        plans.close();
        profile.close();
        contexts.close();
        store.close();
        logger.close();
        lock.release();
      });
    },
  };
}
