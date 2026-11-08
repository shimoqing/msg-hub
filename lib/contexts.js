// Context audit records. Only ids and metadata — never prompt full text,
// never tokens. A responder reports what it actually sent after each wake.

import crypto from "node:crypto";
import { createRegistry } from "./registry.js";
import { IDENTITY_RE } from "./protocol.js";

function reduceContext(list, record) {
  if (!record || record.op !== "append" || !record.context) return;
  if (!IDENTITY_RE.test(record.context.agent ?? "")) return;
  list.push(record);
}

export function createContextStore({
  file,
  now = () => new Date().toISOString(),
  logger = console,
  maxPerAgent = 200,
} = {}) {
  const entries = [];
  const registry = createRegistry({
    file,
    key: (r) => r?.id ?? null,
    reduce: (map, record) => {
      if (!record || typeof record.id !== "string") return;
      reduceContext(entries, record);
      map.set(record.id, record);
    },
    now,
    logger,
  });

  function validate(input) {
    if (!input || typeof input !== "object") throw Object.assign(new Error("context must be an object"), { code: "BAD_INPUT" });
    if (!IDENTITY_RE.test(input.agent ?? "")) throw Object.assign(new Error("invalid agent"), { code: "BAD_INPUT" });
    if (!Number.isInteger(input.trigger_message_id) || input.trigger_message_id <= 0) {
      throw Object.assign(new Error("invalid trigger_message_id"), { code: "BAD_INPUT" });
    }
    if (input.included_message_ids !== undefined && !Array.isArray(input.included_message_ids)) {
      throw Object.assign(new Error("included_message_ids must be an array"), { code: "BAD_INPUT" });
    }
    if (input.file_ids !== undefined && !Array.isArray(input.file_ids)) {
      throw Object.assign(new Error("file_ids must be an array"), { code: "BAD_INPUT" });
    }
    if (input.reply_message_id !== undefined && input.reply_message_id !== null && (!Number.isInteger(input.reply_message_id) || input.reply_message_id <= 0)) {
      throw Object.assign(new Error("invalid reply_message_id"), { code: "BAD_INPUT" });
    }
  }

  return {
    get file() { return registry.file; },

    append(input) {
      validate(input);
      const record = {
        op: "append",
        id: crypto.randomUUID(),
        context: {
          agent: input.agent,
          group: input.group ?? null,
          trigger_message_id: input.trigger_message_id,
          included_message_ids: [...new Set(input.included_message_ids ?? [input.trigger_message_id])],
          file_ids: [...new Set(input.file_ids ?? [])],
          reply_message_id: input.reply_message_id ?? null,
          backend: input.backend ?? null,
          model: input.model ?? null,
          reported_by: input.reported_by ?? input.agent,
          error: input.error ?? null,
        },
      };
      registry.append(record);
      return record.context;
    },

    // Newest first, limited per agent. Only metadata — the caller resolves ids.
    list(agent, limit = 20) {
      const matching = entries.filter((e) => e.context.agent === agent);
      return matching.slice(-Math.min(maxPerAgent, Math.max(1, limit))).reverse();
    },

    close() { registry.close(); },
  };
}
