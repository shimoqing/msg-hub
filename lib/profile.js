// Single-record local profile. Append-only; last upsert wins.
// The server is the source of truth; localStorage is only a first-paint cache.

import { createRegistry } from "./registry.js";
import { IDENTITY_RE } from "./protocol.js";

function reduceProfile(map, record) {
  if (!record || record.op !== "upsert" || !record.profile) return;
  map.set("self", { ...record.profile });
}

export function createProfileStore({
  file,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  const registry = createRegistry({
    file,
    key: () => "self",
    reduce: reduceProfile,
    now,
    logger,
  });

  function validate(input) {
    if (!input || typeof input !== "object") throw Object.assign(new Error("profile must be an object"), { code: "BAD_INPUT" });
    if (!IDENTITY_RE.test(input.operator ?? "")) throw Object.assign(new Error("invalid operator"), { code: "BAD_INPUT" });
    if (typeof input.display_name !== "string" || input.display_name.length === 0 || input.display_name.length > 32) {
      throw Object.assign(new Error("invalid display_name"), { code: "BAD_INPUT" });
    }
    if (input.onboarded !== undefined && typeof input.onboarded !== "boolean") {
      throw Object.assign(new Error("invalid onboarded"), { code: "BAD_INPUT" });
    }
  }

  return {
    get file() { return registry.file; },
    get() { return registry.get("self"); },
    has() { return registry.has("self"); },

    upsert(input) {
      validate(input);
      const prev = registry.get("self") ?? {};
      const profile = {
        operator: input.operator,
        display_name: input.display_name,
        onboarded: input.onboarded ?? prev.onboarded ?? false,
        avatar_hue: input.avatar_hue ?? prev.avatar_hue ?? 18,
        updated_at: now(),
      };
      registry.append({ op: "upsert", profile });
      return registry.get("self");
    },

    close() { registry.close(); },
  };
}
