// Agent-to-agent file handoff. Bytes live under data/files/<id>.bin; the
// index (data/files/index.jsonl) is the durable record of what was uploaded.
// JSONL chat messages only ever carry the small reference, never the bytes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sanitizeFileName(raw) {
  const base = String(raw ?? "").split(/[\\/]+/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file.bin";
  return cleaned.slice(0, 120);
}

function newFileId(now) {
  return `f${now.toString(36)}${crypto.randomBytes(6).toString("hex")}`;
}

export function createFileStore({ dir, maxBytes = 20 * 1024 * 1024, now = Date.now, logger = console } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, "index.jsonl");
  const byId = new Map();

  if (fs.existsSync(indexFile)) {
    const raw = fs.readFileSync(indexFile, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.id === "string") byId.set(rec.id, rec);
      } catch {
        logger?.warn?.("files index: skipping corrupt line");
      }
    }
  }

  function appendIndex(rec) {
    fs.appendFileSync(indexFile, `${JSON.stringify(rec)}\n`, { encoding: "utf8" });
  }

  return {
    put({ name, bytes, by }) {
      if (!Buffer.isBuffer(bytes)) throw Object.assign(new Error("bytes must be a Buffer"), { code: "BAD_INPUT" });
      if (bytes.length > maxBytes) {
        throw Object.assign(new Error(`file exceeds ${maxBytes} bytes`), { code: "TOO_LARGE" });
      }
      const clean = sanitizeFileName(name);
      const rec = {
        id: newFileId(now()),
        name: clean,
        size: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        ts: now(),
        by: by ?? null,
      };
      const abs = path.join(dir, `${rec.id}.bin`);
      // "wx": an id collision would mean a broken generator; fail loudly.
      fs.writeFileSync(abs, bytes, { flag: "wx" });
      appendIndex(rec);
      byId.set(rec.id, rec);
      return { ...rec, path: abs, url: `/files/${rec.id}` };
    },

    has(id) {
      return byId.has(id);
    },

    get(id) {
      const rec = byId.get(id);
      if (!rec) return null;
      return { ...rec, abs: path.join(dir, `${rec.id}.bin`) };
    },

    list(limit = 200) {
      return [...byId.values()]
        .sort((a, b) => b.ts - a.ts || (b.id > a.id ? 1 : -1))
        .slice(0, limit);
    },
  };
}
