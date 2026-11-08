// Partner registry. Append-only JSONL via lib/registry.js.
// Self-registration (from watchers) only updates backend/model/capabilities;
// manual edits (from the UI) only update profile fields. Neither clobbers the other.

import { createRegistry } from "./registry.js";
import { IDENTITY_RE } from "./protocol.js";

const KINDS = new Set(["agent", "human"]);
const BACKENDS = new Set(["claude", "openclaw", "openai", "anthropic", "command", "cc", "dsh", "custom"]);
const CAPABILITIES = new Set(["files", "tasks", "tools", "none"]);
const LAUNCH_MODES = new Set(["local", "manual", "remote"]);

const SELF_FIELDS = ["backend", "model", "capabilities", "last_seen", "version"];
const MANUAL_FIELDS = ["name", "role", "description", "avatar_hue", "enabled", "kind", "launch"];

function normalizeCapabilities(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw Object.assign(new Error("capabilities must be an array"), { code: "BAD_INPUT" });
  const out = [];
  for (const c of value) {
    if (!CAPABILITIES.has(c)) throw Object.assign(new Error(`invalid capability: ${c}`), { code: "BAD_INPUT" });
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function normalizeLaunch(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw Object.assign(new Error("launch must be an object"), { code: "BAD_INPUT" });
  const mode = value.mode ?? "manual";
  if (!LAUNCH_MODES.has(mode)) throw Object.assign(new Error("invalid launch.mode"), { code: "BAD_INPUT" });
  const out = { mode, auto_start: Boolean(value.auto_start) };
  if (value.preset !== undefined) {
    if (typeof value.preset !== "string" || value.preset.length > 32) {
      throw Object.assign(new Error("invalid launch.preset"), { code: "BAD_INPUT" });
    }
    out.preset = value.preset;
  }
  if (value.command !== undefined) {
    if (typeof value.command !== "string" || value.command.length > 256) {
      throw Object.assign(new Error("invalid launch.command"), { code: "BAD_INPUT" });
    }
    out.command = value.command;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((a) => typeof a !== "string" || a.length > 128)) {
      throw Object.assign(new Error("invalid launch.args"), { code: "BAD_INPUT" });
    }
    out.args = [...value.args];
  }
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.length > 256) {
      throw Object.assign(new Error("invalid launch.cwd"), { code: "BAD_INPUT" });
    }
    out.cwd = value.cwd;
  }
  return out;
}

function validateAgent(agent) {
  if (!agent || typeof agent !== "object") throw Object.assign(new Error("agent must be an object"), { code: "BAD_INPUT" });
  if (!IDENTITY_RE.test(agent.id ?? "")) throw Object.assign(new Error("invalid agent id"), { code: "BAD_INPUT" });
  const kind = agent.kind ?? "agent";
  if (!KINDS.has(kind)) throw Object.assign(new Error("invalid agent kind"), { code: "BAD_INPUT" });
  for (const [field, max] of [["name", 32], ["role", 64], ["backend", 64], ["model", 64], ["description", 280]]) {
    if (agent[field] !== undefined && (typeof agent[field] !== "string" || agent[field].length > max)) {
      throw Object.assign(new Error(`invalid ${field}`), { code: "BAD_INPUT" });
    }
  }
  if (agent.backend !== undefined && !BACKENDS.has(agent.backend)) {
    throw Object.assign(new Error("invalid backend"), { code: "BAD_INPUT" });
  }
  if (agent.avatar_hue !== undefined && (!Number.isInteger(agent.avatar_hue) || agent.avatar_hue < 0 || agent.avatar_hue > 360)) {
    throw Object.assign(new Error("invalid avatar_hue"), { code: "BAD_INPUT" });
  }
  if (agent.enabled !== undefined && typeof agent.enabled !== "boolean") {
    throw Object.assign(new Error("invalid enabled"), { code: "BAD_INPUT" });
  }
  normalizeCapabilities(agent.capabilities);
  normalizeLaunch(agent.launch);
}

function reduceAgent(map, record) {
  if (!record || typeof record !== "object") return;
  if (!IDENTITY_RE.test(record.id ?? "")) return;
  if (record.op === "remove") {
    map.delete(record.id);
    return;
  }
  if (record.op !== "upsert" && record.op !== "observe") return;
  const prev = map.get(record.id) ?? {};
  const next = { ...prev, id: record.id };
  if (record.op === "observe") {
    for (const field of SELF_FIELDS) {
      if (record[field] !== undefined) next[field] = record[field];
    }
    next.kind = prev.kind ?? "agent";
    next.name = prev.name ?? record.id;
    next.source = prev.source ?? "self";
    next.enabled = prev.enabled ?? true;
    next.updated_at = record.ts;
  } else {
    for (const field of MANUAL_FIELDS) {
      if (record[field] !== undefined) next[field] = record[field];
    }
    next.kind = record.kind ?? prev.kind ?? "agent";
    next.name = record.name ?? prev.name ?? record.id;
    next.source = "manual";
    next.enabled = record.enabled ?? prev.enabled ?? true;
    next.updated_at = record.ts;
  }
  map.set(record.id, next);
}

export function createAgentRegistry({
  file,
  now = () => new Date().toISOString(),
  logger = console,
  seed = [],
} = {}) {
  const registry = createRegistry({
    file,
    key: (r) => (IDENTITY_RE.test(r?.id ?? "") ? r.id : null),
    reduce: reduceAgent,
    now,
    logger,
    seed: () => seed.map((agent) => ({
      op: "upsert",
      id: agent.id,
      ...agent,
      source: "manual",
      ts: now(),
    })),
  });

  return {
    get file() { return registry.file; },
    get size() { return registry.size; },
    get stats() { return registry.stats; },
    all() { return registry.all(); },
    get(id) { return registry.get(id); },
    has(id) { return registry.has(id); },

    observe(input) {
      validateAgent({ ...input, id: input?.id });
      const record = { op: "observe", id: input.id };
      for (const field of SELF_FIELDS) {
        if (input[field] !== undefined) record[field] = input[field];
      }
      record.capabilities = normalizeCapabilities(input.capabilities) ?? [];
      record.backend = input.backend ?? "custom";
      return registry.append(record);
    },

    upsert(input) {
      validateAgent({ ...input, id: input?.id });
      const record = { op: "upsert", id: input.id };
      for (const field of MANUAL_FIELDS) {
        if (input[field] !== undefined) record[field] = input[field];
      }
      record.kind = input.kind ?? "agent";
      record.name = input.name ?? input.id;
      record.launch = normalizeLaunch(input.launch) ?? { mode: "manual", auto_start: false };
      return registry.append(record);
    },

    remove(id) {
      if (!IDENTITY_RE.test(id ?? "")) throw Object.assign(new Error("invalid agent id"), { code: "BAD_INPUT" });
      return registry.append({ op: "remove", id });
    },

    close() { registry.close(); },
  };
}
