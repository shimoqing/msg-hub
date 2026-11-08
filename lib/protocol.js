// Single source of truth for wire-format primitives shared by server and clients.
// Keep this dependency-free so clients can import it without pulling in the hub.

export const IDENTITY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
export const TOPIC_RE = /^[a-z0-9_-]{1,32}$/;
export const FILE_ID_RE = /^f[a-z0-9]+$/;
export const GROUP_ID_RE = /^(?:g-[a-f0-9]{8}|dm-[a-f0-9]{10})$/;
export const PLAN_ID_RE = /^p-[a-f0-9]{8}$/;

export const MESSAGE_TYPES = new Set(["chat", "data", "sys", "file", "plan"]);

export const WAKE_TYPES = new Set(["chat", "sys"]);
export const NO_WAKE_TYPES = new Set(["data", "plan"]);

export function isIdentity(value) {
  return typeof value === "string" && IDENTITY_RE.test(value);
}

export function isTopic(value) {
  return typeof value === "string" && TOPIC_RE.test(value);
}

export function shouldWakeMessage(message, identity, { allowAgents = false, operator = null, listenActive = false } = {}) {
  if (!message || NO_WAKE_TYPES.has(message.type)) return false;
  if (!WAKE_TYPES.has(message.type)) return false;
  if (message.from === identity) return false;
  if (message.to === identity) return true;
  if (message.to !== "all") return false;
  const body = String(message.body ?? "");
  if (new RegExp(`@${identity}(?![a-zA-Z0-9_-])`).test(body)) return true;
  if (body.includes("@all")) return true;
  if (operator && new RegExp(`@${operator}(?![a-zA-Z0-9_-])`).test(body)) return true;
  if (allowAgents && listenActive) return true;
  return false;
}
