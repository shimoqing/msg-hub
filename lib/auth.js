import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function readToken(tokenFile) {
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return token || null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function ensureToken(tokenFile) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const existing = readToken(tokenFile);
  if (existing) return existing;

  const token = crypto.randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (err) {
    if (err.code === "EEXIST") {
      const raced = readToken(tokenFile);
      if (raced) return raced;
    }
    throw err;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

export function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  try {
    return crypto.timingSafeEqual(sha256(expected), sha256(provided));
  } catch {
    return false;
  }
}

export function extractToken(req, url) {
  const header = req?.headers?.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const queryToken = url?.searchParams?.get("token");
  return queryToken ? queryToken.trim() : null;
}

export function isAuthorized(req, url, expectedToken) {
  return tokenMatches(expectedToken, extractToken(req, url));
}

export function normalizeAddress(address) {
  if (!address) return null;
  let value = String(address).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return mapped;
  }
  return value;
}

function parseIPv4(address) {
  if (!net.isIPv4(address)) return null;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function parseCidr(cidr) {
  if (typeof cidr !== "string") return null;
  const [rawAddress, rawPrefix] = cidr.trim().split("/");
  if (!rawAddress || rawPrefix === undefined) return null;
  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0) return null;

  const mapped = rawAddress.startsWith("::ffff:") ? rawAddress.slice("::ffff:".length) : null;
  if (mapped && net.isIPv4(mapped)) {
    if (prefix < 96) return null;
    return parseCidr(`${mapped}/${prefix - 96}`);
  }

  const normalized = normalizeAddress(rawAddress);
  const ipv4 = parseIPv4(normalized);
  if (ipv4 !== null) {
    if (prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { kind: "v4", network: (ipv4 & mask) >>> 0, prefix };
  }

  if (normalized === "::1") {
    return prefix === 128 ? { kind: "exact", value: "::1" } : null;
  }

  return null;
}

export function isAddressAllowed(remoteAddress, allowedCidrs) {
  const normalized = normalizeAddress(remoteAddress);
  if (!normalized) return false;
  const ipv4 = parseIPv4(normalized);

  for (const entry of allowedCidrs ?? []) {
    const parsed = parseCidr(entry);
    if (!parsed) continue;
    if (parsed.kind === "exact" && normalized === parsed.value) return true;
    if (parsed.kind === "v4" && ipv4 !== null) {
      const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
      if (((ipv4 & mask) >>> 0) === parsed.network) return true;
    }
  }
  return false;
}

export function createRateLimiter({
  perMin = 10,
  windowMs = 60_000,
  now = Date.now,
  maxKeys = 1000,
} = {}) {
  const hits = new Map();

  function prune(t) {
    for (const [key, timestamps] of hits) {
      const kept = timestamps.filter((t0) => t - t0 < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    check(key) {
      const t = now();
      prune(t);
      const timestamps = hits.get(key) ?? [];
      if (timestamps.length >= perMin) {
        const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - t) / 1000));
        return { allowed: false, retryAfter };
      }
      timestamps.push(t);
      hits.set(key, timestamps);
      return { allowed: true, retryAfter: 0 };
    },
    size() {
      return hits.size;
    },
  };
}
