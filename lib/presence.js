// In-memory presence: who has a live SSE connection, who is typing.
// Deliberately NOT persisted — JSONL stays the only source of truth for
// messages; presence is a transient status signal that dies with the process.

const STATES = new Set(["online", "typing", "idle"]);
const IDENTITY_SIMPLE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

export function createPresence({ now = Date.now, onlineTtlMs = 45_000, typingTtlMs = 8_000 } = {}) {
  const entries = new Map(); // identity -> { connections, lastSeen, state, stateAt }

  function validIdentity(identity) {
    if (typeof identity !== "string" || !IDENTITY_SIMPLE.test(identity)) {
      throw new Error(`invalid presence identity: ${JSON.stringify(identity)}`);
    }
  }

  function entry(identity) {
    let e = entries.get(identity);
    if (!e) {
      e = { connections: 0, lastSeen: 0, state: "idle", stateAt: 0 };
      entries.set(identity, e);
    }
    return e;
  }

  return {
    // An identified SSE stream attached.
    attach(identity) {
      validIdentity(identity);
      const e = entry(identity);
      e.connections += 1;
      e.lastSeen = now();
    },

    // The stream detached (explicit close, drop, or hub shutdown).
    detach(identity) {
      validIdentity(identity);
      const e = entries.get(identity);
      if (!e) return;
      if (e.connections > 0) e.connections -= 1;
      e.lastSeen = now();
    },

    // SSE heartbeat: the connection is still alive, refresh last_seen.
    heartbeat(identity) {
      const e = entries.get(identity);
      if (e) e.lastSeen = now();
    },

    // POST /presence from clients that cannot hold an SSE stream open.
    touch(identity, state) {
      validIdentity(identity);
      if (!STATES.has(state)) {
        throw new Error(`invalid presence state: ${JSON.stringify(state)}`);
      }
      const e = entry(identity);
      e.state = state;
      e.stateAt = now();
      e.lastSeen = e.stateAt;
    },

    snapshot() {
      const t = now();
      const out = [];
      for (const [identity, e] of entries) {
        const online = e.connections > 0 || t - e.lastSeen <= onlineTtlMs;
        if (!online && e.connections === 0) continue;
        out.push({
          identity,
          connections: e.connections,
          online,
          typing: online && e.state === "typing" && t - e.stateAt <= typingTtlMs,
          last_seen: e.lastSeen,
        });
      }
      out.sort((a, b) => a.identity.localeCompare(b.identity));
      return out;
    },
  };
}
