import fs from "node:fs";
import path from "node:path";
import { normalizeAddress } from "./auth.js";

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "application/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, headers);
}

export function sendUnauthorized(res) {
  sendError(res, 401, "unauthorized", "missing or invalid token", {
    "WWW-Authenticate": 'Bearer realm="msg-hub"',
  });
}

export function sendMethodNotAllowed(res, allow) {
  sendError(res, 405, "method_not_allowed", "method not allowed", { Allow: allow });
}

export function sendNotFound(res) {
  sendError(res, 404, "not_found", "not found");
}

export function sendTooLarge(req, res, limit) {
  const body = JSON.stringify({
    ok: false,
    error: { code: "too_large", message: `body exceeds ${limit} bytes` },
  });
  res.writeHead(413, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  });
  res.end(body);
  // Let the client read the response before the socket is torn down.
  res.on("finish", () => {
    try {
      req.destroy();
    } catch {
      /* ignore */
    }
  });
}

export function readJsonBody(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.code = code;
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        fail("TOO_LARGE", `body exceeds ${limit} bytes`);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) {
          const error = new Error("empty body");
          error.code = "BAD_JSON";
          throw error;
        }
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          const error = new Error("body must be a JSON object");
          error.code = "BAD_JSON";
          throw error;
        }
        resolve(value);
      } catch (err) {
        if (!err.code) err.code = "BAD_JSON";
        reject(err);
      }
    });

    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function readRawBody(req, { limit = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      req.pause();
      const error = new Error(message);
      error.code = code;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail("TOO_LARGE", `body exceeds ${limit} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function isLoopback(address) {
  const normalized = normalizeAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function serveStatic(req, res, { urlPath, token, publicDir, remoteAddress }) {
  const entry = STATIC_FILES.get(urlPath);
  if (!entry) {
    sendNotFound(res);
    return;
  }

  let body;
  try {
    body = fs.readFileSync(path.join(publicDir, entry.file), "utf8");
  } catch {
    sendError(res, 500, "static_missing", "static file missing");
    return;
  }

  if (entry.file === "index.html") {
    const injected = isLoopback(remoteAddress) ? token : "";
    body = body.replace("__MSGHUB_TOKEN_JSON__", JSON.stringify(injected));
  }

  res.writeHead(200, {
    "Content-Type": entry.type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": entry.file === "index.html" ? "no-store" : "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(body);
}
