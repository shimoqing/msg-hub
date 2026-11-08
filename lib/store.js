import fs from "node:fs";
import path from "node:path";

import { IDENTITY_RE, TOPIC_RE, MESSAGE_TYPES } from "./protocol.js";

export { IDENTITY_RE, TOPIC_RE, MESSAGE_TYPES } from "./protocol.js";
export const MESSAGE_FILE_RE = /^chat-\d{4}-\d{2}-\d{2}\.jsonl$/;

const pad2 = (n) => String(n).padStart(2, "0");

export function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localIso(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${offset}`
  );
}

export function writeAllSync(fd, buffer, writeSync = fs.writeSync, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const written =
      position === null
        ? writeSync(fd, buffer, offset, buffer.length - offset)
        : writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`short write at ${offset}/${buffer.length}`);
    }
    offset += written;
  }
  return offset;
}

function sigOf(stat) {
  return stat
    ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }
    : null;
}

function fileSig(file) {
  return sigOf(fs.statSync(file, { throwIfNoEntry: false }));
}

function sameSig(a, b) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.ino === b.ino)
  );
}

function sameSigList(a, b) {
  return a.length === b.length && a.every((sig, index) => sameSig(sig, b[index]));
}

export function acquireLock(dataDir, { kill = process.kill, now = () => new Date() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "hub.lock");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = `${JSON.stringify({ pid: process.pid, started_at: now().toISOString() })}\n`;
      fs.writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
      return {
        path: lockPath,
        pid: process.pid,
        release() {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      let lock = null;
      try {
        lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        /* corrupt lock: treat as stale */
      }

      const pid = lock?.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        continue;
      }

      let alive = true;
      try {
        kill(pid, 0);
      } catch (probeErr) {
        // Windows may throw EPERM even when the process exists; only ESRCH is proof of death.
        alive = probeErr.code !== "ESRCH";
      }

      if (alive) {
        const error = new Error(`msg-hub already running (pid ${pid})`);
        error.code = "LOCKED";
        error.pid = pid;
        throw error;
      }

      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  const error = new Error("could not acquire msg-hub lock");
  error.code = "LOCKED";
  throw error;
}

export class Store {
  constructor({
    dataDir,
    retentionDays = 2,
    bodyLimit = 64 * 1024,
    maxCacheBytes = 64 * 1024 * 1024,
    maxCacheMessages = 150_000,
    now = () => new Date(),
    logger = console,
  } = {}) {
    this.dataDir = dataDir;
    this.retentionDays = retentionDays;
    this.bodyLimit = bodyLimit;
    this.maxCacheBytes = maxCacheBytes;
    this.maxCacheMessages = maxCacheMessages;
    this.now = now;
    this.logger = logger;
    this.fd = null;
    this.currentDateKey = null;
    this.lastMessageId = 0;
    // Derived snapshot of readWindow(): { keys, sigs, messages }. Never a source of truth.
    this._window = null;
  }

  get lastId() {
    return this.lastMessageId;
  }

  filePath(dateKey) {
    return path.join(this.dataDir, `chat-${dateKey}.jsonl`);
  }

  openFile(dateKey) {
    const file = this.filePath(dateKey);
    try {
      // "r+" lets Windows ftruncate a failed partial write; O_APPEND does not.
      return fs.openSync(file, "r+");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return fs.openSync(file, "w+");
    }
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.lastMessageId = this.recoverLastId();
    this.currentDateKey = localDateKey(this.now());
    this.fd = this.openFile(this.currentDateKey);
    return this;
  }

  recoverLastId() {
    let files = [];
    try {
      files = fs
        .readdirSync(this.dataDir)
        .filter((name) => MESSAGE_FILE_RE.test(name))
        .sort()
        .reverse();
    } catch {
      return 0;
    }

    for (const name of files.slice(0, 3)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.dataDir, name), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (Number.isInteger(message.id) && message.id > 0) return message.id;
        } catch {
          /* corrupt tail: keep scanning backwards */
        }
      }
    }
    return 0;
  }

  rotateIfNeeded(now) {
    const key = localDateKey(now);
    if (key === this.currentDateKey) return;
    this._window = null;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
    }
    this.currentDateKey = key;
    this.fd = this.openFile(key);
  }

  append(input) {
    if (!input || typeof input.body !== "string" || input.body.length === 0) {
      throw new Error("body is required");
    }
    if (!IDENTITY_RE.test(input.from)) throw new Error("invalid from");
    const to = input.to ?? "all";
    if (to !== "all" && !IDENTITY_RE.test(to)) throw new Error("invalid to");
    const topic = input.topic ?? "daily";
    if (!TOPIC_RE.test(topic)) throw new Error("invalid topic");
    const type = input.type ?? "chat";
    if (!MESSAGE_TYPES.has(type)) throw new Error("invalid type");
    const replyTo = input.reply_to ?? null;
    if (replyTo !== null && (!Number.isInteger(replyTo) || replyTo <= 0)) {
      throw new Error("invalid reply_to");
    }
    if (Buffer.byteLength(input.body, "utf8") > this.bodyLimit) {
      throw new Error("body too large");
    }

    const now = this.now();
    this.rotateIfNeeded(now);
    const id = this.lastMessageId + 1;
    const message = {
      id,
      ts: localIso(now),
      from: input.from,
      to,
      topic,
      type,
      body: input.body,
      reply_to: replyTo,
    };
    const line = `${JSON.stringify(message)}\n`;
    const buffer = Buffer.from(line, "utf8");
    const beforeStat = fs.fstatSync(this.fd);
    const before = beforeStat.size;

    try {
      writeAllSync(this.fd, buffer, fs.writeSync, before);
      fs.fsyncSync(this.fd);
    } catch (err) {
      try {
        fs.ftruncateSync(this.fd, before);
      } catch {
        // Last resort: reopen and retry the rollback once.
        try {
          fs.closeSync(this.fd);
          this.fd = this.openFile(this.currentDateKey);
          fs.ftruncateSync(this.fd, before);
        } catch {
          /* leave a corrupt tail for recovery to skip */
        }
      }
      throw err;
    }

    this.lastMessageId = id;
    try {
      const snapshot = this._window;
      const last = snapshot?.messages[snapshot.messages.length - 1];
      if (
        snapshot &&
        snapshot.keys[0] === this.currentDateKey &&
        sameSig(snapshot.sigs[0], sigOf(beforeStat)) &&
        (!last || id > last.id)
      ) {
        snapshot.messages.push(message);
        snapshot.sigs[0] = sigOf(fs.fstatSync(this.fd));
      } else {
        // Unknown or external change since the snapshot: let the next read reload it.
        this._window = null;
      }
    } catch {
      // Persistence already succeeded; a cache-update failure must not fail the send.
      this._window = null;
    }
    return message;
  }

  readWindow(now = this.now()) {
    const byId = new Map();
    let skipped = 0;

    for (let i = 0; i < this.retentionDays; i += 1) {
      const key = localDateKey(new Date(now.getTime() - i * 86_400_000));
      const file = this.filePath(key);
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          if (
            Number.isInteger(message.id) &&
            message.id > 0 &&
            typeof message.body === "string" &&
            typeof message.from === "string"
          ) {
            byId.set(message.id, message);
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }
    }

    if (skipped > 0) {
      this.logger?.warn?.(`skipped ${skipped} corrupt JSONL line(s)`);
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  windowKeys(now = this.now()) {
    const keys = [];
    for (let i = 0; i < this.retentionDays; i += 1) {
      keys.push(localDateKey(new Date(now.getTime() - i * 86_400_000)));
    }
    return keys;
  }

  _currentSigs(keys) {
    return keys.map((key) => fileSig(this.filePath(key)));
  }

  _cacheWindow(keys, sigs, messages) {
    const rawBytes = sigs.reduce((sum, sig) => sum + (sig ? sig.size : 0), 0);
    this._window =
      messages.length <= this.maxCacheMessages && rawBytes <= this.maxCacheBytes
        ? { keys, sigs, messages }
        : null;
    return messages;
  }

  _getWindow() {
    const now = this.now();
    const keys = this.windowKeys(now);
    const sigs = this._currentSigs(keys);
    const cached = this._window;
    if (
      cached &&
      cached.keys.length === keys.length &&
      cached.keys.every((key, index) => key === keys[index]) &&
      sameSigList(cached.sigs, sigs)
    ) {
      return cached.messages;
    }

    // Re-stat around the read so a file write cannot be cached as if it had been read.
    let before = sigs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const messages = this.readWindow(now);
      const after = this._currentSigs(keys);
      if (sameSigList(before, after)) return this._cacheWindow(keys, after, messages);
      before = after;
    }
    // The window kept changing while reading; serve fresh data without caching it.
    this._window = null;
    return this.readWindow(now);
  }

  since(id, { topic = "all", to = null, limit = 200 } = {}) {
    const all = this._getWindow();
    const messages = all.filter(
      (m) =>
        m.id > id &&
        (topic === "all" || !topic || m.topic === topic) &&
        (!to || m.to === "all" || m.to === to),
    );
    return {
      messages: messages.slice(0, Math.max(1, limit)),
      lastId: this.lastMessageId,
      oldestAvailableId: all.length ? all[0].id : this.lastMessageId,
    };
  }

  recent({ limit = 50, topic = "all", to = null } = {}) {
    const all = this._getWindow();
    const messages = all.filter(
      (m) =>
        (topic === "all" || !topic || m.topic === topic) &&
        (!to || m.to === "all" || m.to === to),
    );
    return {
      messages: messages.slice(-Math.max(1, limit)),
      lastId: this.lastMessageId,
    };
  }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    this._window = null;
  }
}
