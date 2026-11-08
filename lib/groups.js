// Group / DM registry. Append-only JSONL. Dynamic topics are the union of
// config.topics and group ids; archived groups reject writes but stay readable.

import crypto from "node:crypto";
import { createRegistry } from "./registry.js";
import { IDENTITY_RE, TOPIC_RE, GROUP_ID_RE } from "./protocol.js";

const KINDS = new Set(["group", "dm"]);
const REPLY_MODES = new Set(["mention", "all"]);
const TOPIC_NAMES = { ctf: "CTF", src: "SRC", daily: "日常", sys: "系统" };

function dmId(members) {
  const sorted = [...new Set(members)].sort();
  if (sorted.length !== 2) throw Object.assign(new Error("DM requires exactly 2 members"), { code: "BAD_INPUT" });
  return `dm-${crypto.createHash("sha1").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 10)}`;
}

function groupId() {
  return `g-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeMembers(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw Object.assign(new Error("members must be an array of at most 20"), { code: "BAD_INPUT" });
  }
  const out = [];
  for (const m of value) {
    if (!IDENTITY_RE.test(m)) throw Object.assign(new Error("invalid member"), { code: "BAD_INPUT" });
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function validateGroup(group) {
  if (!group || typeof group !== "object") throw Object.assign(new Error("group must be an object"), { code: "BAD_INPUT" });
  const kind = group.kind ?? "group";
  if (!KINDS.has(kind)) throw Object.assign(new Error("invalid group kind"), { code: "BAD_INPUT" });
  const members = normalizeMembers(group.members ?? []);
  if (kind === "dm" && members.length !== 2) {
    throw Object.assign(new Error("DM requires exactly 2 members"), { code: "BAD_INPUT" });
  }
  if (group.name !== undefined && group.name !== null && (typeof group.name !== "string" || group.name.length > 64)) {
    throw Object.assign(new Error("invalid group name"), { code: "BAD_INPUT" });
  }
  if (kind === "group" && !group.name) {
    throw Object.assign(new Error("group name is required"), { code: "BAD_INPUT" });
  }
  if (group.reply_mode !== undefined && !REPLY_MODES.has(group.reply_mode)) {
    throw Object.assign(new Error("invalid reply_mode"), { code: "BAD_INPUT" });
  }
  if (group.auto_handoff !== undefined && typeof group.auto_handoff !== "boolean") {
    throw Object.assign(new Error("invalid auto_handoff"), { code: "BAD_INPUT" });
  }
  if (group.archived !== undefined && typeof group.archived !== "boolean") {
    throw Object.assign(new Error("invalid archived"), { code: "BAD_INPUT" });
  }
  if (group.lead !== undefined && group.lead !== null && !IDENTITY_RE.test(group.lead)) {
    throw Object.assign(new Error("invalid lead"), { code: "BAD_INPUT" });
  }
}

function reduceGroup(map, record) {
  if (!record || typeof record !== "object") return;
  if (!GROUP_ID_RE.test(record.id ?? "") && !/^[a-z0-9_-]{1,32}$/.test(record.id ?? "")) return;
  if (record.op === "remove") {
    map.delete(record.id);
    return;
  }
  if (record.op !== "upsert") return;
  const prev = map.get(record.id) ?? {};
  const next = { ...prev, ...record.group, id: record.id };
  next.archived = next.archived ?? false;
  next.members = next.members ?? [];
  next.kind = next.kind ?? "group";
  map.set(record.id, next);
}

export function createGroupRegistry({
  file,
  configTopics = ["ctf", "src", "daily", "sys"],
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  const seed = configTopics.map((topic) => ({
    op: "upsert",
    id: topic,
    group: {
      id: topic,
      kind: "group",
      name: TOPIC_NAMES[topic] ?? topic,
      members: [],
      lead: null,
      reply_mode: "mention",
      auto_handoff: false,
      archived: false,
      created_by: "system",
      created_at: now(),
      updated_at: now(),
    },
  }));
  const registry = createRegistry({
    file,
    key: (r) => (GROUP_ID_RE.test(r?.id ?? "") || /^[a-z0-9_-]{1,32}$/.test(r?.id ?? "") ? r.id : null),
    reduce: reduceGroup,
    now,
    logger,
    seed: () => seed,
  });

  function writableTopics() {
    const out = new Set(configTopics);
    for (const group of registry.values()) {
      if (!group.archived) out.add(group.id);
    }
    return out;
  }

  return {
    get file() { return registry.file; },
    get size() { return registry.size; },
    get stats() { return registry.stats; },
    all() { return registry.all(); },
    get(id) { return registry.get(id); },
    has(id) { return registry.has(id); },
    values() { return registry.values(); },

    // A topic is readable if it's a legacy config topic or any known group.
    canRead(topic) {
      if (topic === "all") return true;
      return configTopics.includes(topic) || registry.has(topic);
    },

    // A topic is writable if it's a config topic or a non-archived group.
    canWrite(topic) {
      if (!GROUP_ID_RE.test(topic) && !configTopics.includes(topic)) return false;
      return writableTopics().has(topic);
    },

    create(input) {
      const kind = input.kind ?? "group";
      const members = normalizeMembers(input.members ?? []);
      const id = kind === "dm" ? dmId(members) : (GROUP_ID_RE.test(input.id ?? "") ? input.id : groupId());
      const group = {
        id,
        kind,
        name: kind === "dm" ? (input.name ?? null) : (input.name ?? ""),
        members,
        lead: input.lead ?? null,
        reply_mode: kind === "dm" ? "mention" : (input.reply_mode ?? "mention"),
        auto_handoff: kind === "dm" ? false : Boolean(input.auto_handoff),
        archived: false,
        created_by: input.created_by ?? "system",
        created_at: now(),
        updated_at: now(),
      };
      validateGroup(group);
      if (registry.has(id) && kind !== "dm") {
        throw Object.assign(new Error("group id already exists"), { code: "CONFLICT" });
      }
      registry.append({ op: "upsert", id, group });
      return registry.get(id);
    },

    update(id, patch) {
      const prev = registry.get(id);
      if (!prev) throw Object.assign(new Error("group not found"), { code: "NOT_FOUND" });
      const merged = { ...prev };
      for (const field of ["name", "members", "lead", "reply_mode", "auto_handoff", "archived"]) {
        if (patch[field] !== undefined) merged[field] = patch[field];
      }
      merged.id = id;
      merged.updated_at = now();
      validateGroup(merged);
      registry.append({ op: "upsert", id, group: merged });
      return registry.get(id);
    },

    findDm(a, b) {
      const id = dmId([a, b]);
      return registry.get(id) ?? null;
    },

    remove(id) {
      if (!GROUP_ID_RE.test(id) && !/^[a-z0-9_-]{1,32}$/.test(id)) throw Object.assign(new Error("invalid group id"), { code: "BAD_INPUT" });
      registry.append({ op: "remove", id });
    },

    close() { registry.close(); },
  };
}

export { dmId, TOPIC_NAMES };
