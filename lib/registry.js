// Generic append-only JSONL registry. One record per line, last-write-wins by
// the record's own key. Mirrors the durability rules of lib/store.js:
// open with "r+"/"w+" (not "a") so a failed partial write can be rolled back
// with ftruncate on Windows, then fsync before the caller broadcasts anything.

import fs from "node:fs";
import path from "node:path";
import { writeAllSync } from "./store.js";

function emptyStats() {
  return { total: 0, skipped: 0, applied: 0 };
}

export function createRegistry({
  file,
  key,
  reduce,
  seed = () => [],
  now = () => new Date().toISOString(),
  logger = console,
  maxRecords = 50_000,
  writeSync = fs.writeSync,
} = {}) {
  if (typeof file !== "string" || !file) throw new Error("registry file is required");
  if (typeof key !== "function") throw new Error("registry key function is required");
  if (typeof reduce !== "function") throw new Error("registry reduce function is required");

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const map = new Map();
  let stats = emptyStats();
  let fd = null;

  function load() {
    map.clear();
    stats = emptyStats();
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      stats.total += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        stats.skipped += 1;
        logger?.warn?.(`${path.basename(file)}: skipping corrupt line ${i + 1}`);
        continue;
      }
      try {
        reduce(map, record);
        stats.applied += 1;
      } catch {
        stats.skipped += 1;
        logger?.warn?.(`${path.basename(file)}: skipping invalid record on line ${i + 1}`);
      }
    }
    if (stats.total === 0 && map.size === 0) {
      const seedRecords = seed();
      for (const seedRecord of seedRecords) {
        try {
          reduce(map, seedRecord);
        } catch {
          /* bad seed: ignore */
        }
      }
      if (seedRecords.length > 0 && text === "") appendMany(seedRecords);
    }
  }

  function openFd() {
    if (fd !== null) return fd;
    try {
      fd = fs.openSync(file, "r+");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      fd = fs.openSync(file, "w+");
    }
    return fd;
  }

  function appendMany(records) {
    if (!records.length) return [];
    const payload = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    const buffer = Buffer.from(payload, "utf8");
    const handle = openFd();
    const before = fs.fstatSync(handle).size;
    try {
      writeAllSync(handle, buffer, writeSync, before);
      fs.fsyncSync(handle);
    } catch (err) {
      try {
        fs.ftruncateSync(handle, before);
      } catch {
        try {
          fs.closeSync(handle);
          fd = fs.openSync(file, "w+");
          fs.ftruncateSync(fd, before);
        } catch {
          /* leave a corrupt tail for the next replay to skip */
        }
      }
      throw err;
    }
    for (const record of records) reduce(map, record);
    return records;
  }

  load();

  return {
    file,
    get size() {
      return map.size;
    },
    get stats() {
      return { ...stats };
    },
    all() {
      return [...map.values()];
    },
    get(id) {
      return map.get(id) ?? null;
    },
    has(id) {
      return map.has(id);
    },
    values() {
      return map.values();
    },
    append(record) {
      if (!record || typeof record !== "object") throw new Error("record must be an object");
      if (map.size >= maxRecords) throw new Error("registry is full");
      const id = key(record);
      if (id === null || id === undefined) throw new Error("record has no key");
      const stamped = { ...record, ts: record.ts ?? now() };
      appendMany([stamped]);
      return map.get(id);
    },
    appendBatch(records) {
      if (!Array.isArray(records) || records.length === 0) return [];
      if (map.size + records.length > maxRecords) throw new Error("registry is full");
      const stamped = records.map((r) => {
        if (!r || typeof r !== "object") throw new Error("record must be an object");
        const id = key(r);
        if (id === null || id === undefined) throw new Error("record has no key");
        return { ...r, ts: r.ts ?? now() };
      });
      appendMany(stamped);
      return stamped.map((r) => map.get(key(r)));
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
    },
  };
}
