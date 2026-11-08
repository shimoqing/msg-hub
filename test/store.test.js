import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Store,
  acquireLock,
  localDateKey,
  localIso,
  writeAllSync,
} from "../lib/store.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-store-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const silentLogger = { info() {}, warn() {}, error() {} };

test("writeAllSync loops until every byte is written", () => {
  const source = Buffer.from("abcdefghij", "utf8");
  const chunks = [];
  const written = writeAllSync(3, source, (_fd, buffer, offset, length) => {
    const size = Math.min(3, length);
    chunks.push(buffer.subarray(offset, offset + size));
    return size;
  });
  assert.equal(written, source.length);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdefghij");
});

test("writeAllSync throws instead of spinning on a zero-byte write", () => {
  assert.throws(() => writeAllSync(3, Buffer.from("x"), () => 0), /short write/);
  assert.throws(() => writeAllSync(3, Buffer.from("x"), () => -1), /short write/);
});

test("localDateKey and localIso use local time", () => {
  const date = new Date(2026, 10, 5, 9, 7, 3);
  assert.equal(localDateKey(date), "2026-11-05");
  assert.match(localIso(date), /^2026-11-05T09:07:03[+-]\d{2}:\d{2}$/);
});

test("append assigns monotonic ids and persists fields", () => {
  const dir = makeTempDir();
  const store = new Store({
    dataDir: dir,
    now: () => new Date(2026, 10, 5, 10, 0, 0),
    logger: silentLogger,
  }).init();
  try {
    const first = store.append({ from: "cc", topic: "ctf", body: "hello @dsh" });
    const second = store.append({
      from: "dsh",
      to: "cc",
      topic: "sys",
      type: "data",
      body: "E:\\共享文件夹\\a.txt",
      reply_to: first.id,
    });
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(second.to, "cc");
    assert.equal(second.reply_to, 1);
    assert.equal(store.lastId, 2);

    const file = path.join(dir, "chat-2026-11-05.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), first);
    assert.deepEqual(JSON.parse(lines[1]), second);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("append rolls back a partial write and keeps the next line readable", () => {
  const dir = makeTempDir();
  const store = new Store({
    dataDir: dir,
    now: () => new Date(2026, 10, 5, 10, 0, 0),
    logger: silentLogger,
  }).init();
  const file = path.join(dir, "chat-2026-11-05.jsonl");
  const originalWriteSync = fs.writeSync;
  try {
    assert.equal(store.append({ from: "cc", body: "first" }).id, 1);
    const beforeSize = fs.statSync(file).size;

    let calls = 0;
    fs.writeSync = (fd, buffer, offset, length, position) => {
      calls += 1;
      if (calls === 1) {
        return originalWriteSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      }
      const error = new Error("simulated write failure");
      error.code = "EIO";
      throw error;
    };
    assert.throws(
      () => store.append({ from: "cc", body: "must roll back" }),
      /simulated write failure/,
    );
    assert.equal(store.lastId, 1);
    assert.equal(fs.statSync(file).size, beforeSize);

    fs.writeSync = originalWriteSync;
    assert.equal(store.append({ from: "cc", body: "after failure" }).id, 2);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).body, "after failure");
  } finally {
    fs.writeSync = originalWriteSync;
    store.close();
    cleanup(dir);
  }
});

test("append rejects invalid fields and oversized bodies", () => {
  const dir = makeTempDir();
  const store = new Store({
    dataDir: dir,
    bodyLimit: 8,
    now: () => new Date(2026, 10, 5, 10, 0, 0),
    logger: silentLogger,
  }).init();
  try {
    assert.throws(() => store.append({ from: "CC", body: "x" }), /invalid from/);
    assert.throws(() => store.append({ from: "cc", to: "bad to", body: "x" }), /invalid to/);
    assert.throws(() => store.append({ from: "cc", topic: "nope!", body: "x" }), /invalid topic/);
    assert.throws(() => store.append({ from: "cc", type: "notice", body: "x" }), /invalid type/);
    assert.throws(() => store.append({ from: "cc", body: "" }), /body is required/);
    assert.throws(() => store.append({ from: "cc", body: "123456789" }), /body too large/);
    assert.throws(
      () => store.append({ from: "cc", body: "x", reply_to: "1" }),
      /invalid reply_to/,
    );
    assert.equal(store.lastId, 0);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("init recovers the last valid id and skips a corrupt tail", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "chat-2026-11-05.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ id: 41, ts: "x", from: "cc", topic: "daily", body: "a" }),
      JSON.stringify({ id: 42, ts: "x", from: "cc", topic: "daily", body: "b" }),
      '{"id":43,"broken":',
      "",
    ].join("\n"),
  );

  const store = new Store({
    dataDir: dir,
    now: () => new Date(2026, 10, 5, 10, 0, 0),
    logger: silentLogger,
  }).init();
  try {
    assert.equal(store.lastId, 42);
    const message = store.append({ from: "cc", body: "next" });
    assert.equal(message.id, 43);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("append rotates to a new daily file and keeps ids increasing", () => {
  const dir = makeTempDir();
  let now = new Date(2026, 10, 5, 23, 59, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    assert.equal(store.append({ from: "cc", body: "day one" }).id, 1);
    now = new Date(2026, 10, 6, 0, 1, 0);
    assert.equal(store.append({ from: "cc", body: "day two" }).id, 2);
    assert.ok(fs.existsSync(path.join(dir, "chat-2026-11-05.jsonl")));
    assert.ok(fs.existsSync(path.join(dir, "chat-2026-11-06.jsonl")));
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("readWindow dedupes ids and skips corrupt lines", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", topic: "ctf", body: "one" });
    store.append({ from: "dsh", to: "cc", topic: "sys", body: "two" });
    fs.appendFileSync(path.join(dir, "chat-2026-11-05.jsonl"), "not-json\n");

    const recent = store.recent({ limit: 10 });
    assert.deepEqual(
      recent.messages.map((m) => m.body),
      ["one", "two"],
    );
    assert.equal(recent.lastId, 2);

    assert.deepEqual(
      store.recent({ topic: "sys" }).messages.map((m) => m.id),
      [2],
    );
    assert.deepEqual(
      store.recent({ to: "cc" }).messages.map((m) => m.id),
      [1, 2],
    );
    assert.deepEqual(
      store.since(1).messages.map((m) => m.id),
      [2],
    );
    assert.equal(store.since(1).oldestAvailableId, 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

function makeMessage(id, now, overrides = {}) {
  return {
    id,
    ts: localIso(now),
    from: "cc",
    to: "all",
    topic: "daily",
    type: "chat",
    body: `message ${id}`,
    reply_to: null,
    ...overrides,
  };
}

function ids(messages) {
  return messages.map((message) => message.id);
}

function oracleRecent(all, { limit = 50, topic = "all", to = null } = {}) {
  const take = Math.max(1, limit);
  return all
    .filter(
      (message) =>
        (topic === "all" || !topic || message.topic === topic) &&
        (!to || message.to === "all" || message.to === to),
    )
    .slice(-take);
}

function oracleSince(all, id, { limit = 200, topic = "all", to = null } = {}) {
  const take = Math.max(1, limit);
  return all
    .filter(
      (message) =>
        message.id > id &&
        (topic === "all" || !topic || message.topic === topic) &&
        (!to || message.to === "all" || message.to === to),
    )
    .slice(0, take);
}

test("window cache notices a valid out-of-band append", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", body: "one" });
    store.append({ from: "dsh", to: "cc", topic: "sys", body: "two" });
    assert.equal(store.recent({ limit: 10 }).messages.length, 2);
    fs.appendFileSync(
      path.join(dir, "chat-2026-11-05.jsonl"),
      `${JSON.stringify(makeMessage(99, now, { from: "xing", body: "external" }))}\n`,
    );
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2, 99]);
    assert.deepEqual(ids(store.since(0).messages), [1, 2, 99]);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("window cache skips an out-of-band corrupt line and recovers", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", body: "one" });
    store.append({ from: "cc", body: "two" });
    assert.equal(store.recent({ limit: 10 }).messages.length, 2);
    fs.appendFileSync(path.join(dir, "chat-2026-11-05.jsonl"), "not-json\n");
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2]);
    fs.appendFileSync(
      path.join(dir, "chat-2026-11-05.jsonl"),
      `${JSON.stringify(makeMessage(3, now, { body: "after corrupt" }))}\n`,
    );
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2, 3]);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("window cache notices truncate and rewrite", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", body: "one" });
    store.append({ from: "cc", body: "two" });
    assert.equal(store.recent({ limit: 10 }).messages.length, 2);
    fs.writeFileSync(
      path.join(dir, "chat-2026-11-05.jsonl"),
      `${JSON.stringify(makeMessage(7, now, { body: "rewritten file" }))}\n`,
    );
    const recent = store.recent({ limit: 10 });
    assert.deepEqual(ids(recent.messages), [7]);
    assert.equal(store.since(0).oldestAvailableId, 7);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("window cache drops days outside the retention window", () => {
  const dir = makeTempDir();
  let now = new Date(2026, 10, 5, 23, 59, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", body: "day five" });
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1]);
    now = new Date(2026, 10, 7, 0, 1, 0);
    store.append({ from: "cc", body: "day seven" });
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [2]);
    assert.equal(store.since(1).oldestAvailableId, 2);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("window cache handles an empty window", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    assert.deepEqual(store.recent({ limit: 10 }).messages, []);
    const since = store.since(0);
    assert.deepEqual(since.messages, []);
    assert.equal(since.oldestAvailableId, 0);
    assert.equal(since.lastId, 0);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("since before the first available id keeps the window's oldest id", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const file = path.join(dir, "chat-2026-11-05.jsonl");
  const lines = [];
  for (let id = 100; id <= 110; id += 1) lines.push(JSON.stringify(makeMessage(id, now)));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    const since = store.since(50, { limit: 3 });
    assert.deepEqual(ids(since.messages), [100, 101, 102]);
    assert.equal(since.oldestAvailableId, 100);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("cache and oracle agree on topic/to/limit matrices", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    for (let id = 1; id <= 12; id += 1) {
      store.append({
        from: id % 2 === 0 ? "dsh" : "cc",
        to: id % 3 === 0 ? "cc" : "all",
        topic: ["ctf", "src", "daily", "sys"][id % 4],
        body: `message ${id}`,
      });
    }
    store.recent({ limit: 12 }); // warm
    const all = store.readWindow();
    for (const topic of ["all", "ctf", "src", "daily", "sys"]) {
      for (const to of [null, "cc", "dsh"]) {
        for (const limit of [1, 2, 5, 12]) {
          assert.deepEqual(
            ids(store.recent({ limit, topic, to }).messages),
            ids(oracleRecent(all, { limit, topic, to })),
            `recent ${topic}/${to}/${limit}`,
          );
          assert.deepEqual(
            ids(store.since(5, { limit, topic, to }).messages),
            ids(oracleSince(all, 5, { limit, topic, to })),
            `since ${topic}/${to}/${limit}`,
          );
        }
      }
    }
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("own append updates the warm cache without rereading JSONL", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    store.append({ from: "cc", body: "one" });
    assert.equal(store.recent({ limit: 10 }).messages.length, 1);
    fs.readFileSync = (...args) => {
      reads += 1;
      return originalRead.apply(fs, args);
    };
    store.append({ from: "cc", body: "two" });
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2]);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = originalRead;
    store.close();
    cleanup(dir);
  }
});

test("out-of-band append followed by own append is not hidden by the cache", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    store.append({ from: "cc", body: "one" });
    store.append({ from: "cc", body: "two" });
    assert.equal(store.recent({ limit: 10 }).messages.length, 2);
    fs.appendFileSync(
      path.join(dir, "chat-2026-11-05.jsonl"),
      `${JSON.stringify(makeMessage(99, now, { body: "external" }))}\n`,
    );
    store.append({ from: "cc", body: "three" });
    const recent = store.recent({ limit: 10 });
    assert.deepEqual(ids(recent.messages), [1, 2, 3, 99]);
    assert.equal(recent.messages.find((message) => message.id === 99).body, "external");
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("duplicate ids across days preserve the oracle's precedence", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  fs.writeFileSync(
    path.join(dir, "chat-2026-11-04.jsonl"),
    `${JSON.stringify(makeMessage(5, now, { body: "yesterday" }))}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "chat-2026-11-05.jsonl"),
    `${[
      JSON.stringify(makeMessage(5, now, { body: "today" })),
      JSON.stringify(makeMessage(7, now, { body: "today seven" })),
    ].join("\n")}\n`,
  );
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  try {
    const oracle = store.readWindow();
    const recent = store.recent({ limit: 10 });
    assert.deepEqual(recent.messages, oracle);
    assert.equal(recent.messages.find((message) => message.id === 5).body, "yesterday");
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("cache remains differential-equivalent after mixed writes", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({ dataDir: dir, now: () => now, logger: silentLogger }).init();
  let seed = 0x12345678;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  try {
    for (let i = 1; i <= 30; i += 1) {
      store.append({
        from: ["cc", "dsh", "xing"][i % 3],
        to: i % 4 === 0 ? "cc" : "all",
        topic: ["ctf", "src", "daily", "sys"][i % 4],
        body: `seed ${i}`,
      });
    }
    store.recent({ limit: 10 }); // warm
    fs.appendFileSync(
      path.join(dir, "chat-2026-11-05.jsonl"),
      `${JSON.stringify(makeMessage(1000, now, { from: "xing", body: "external" }))}\n`,
    );
    fs.appendFileSync(path.join(dir, "chat-2026-11-05.jsonl"), "broken\n");
    for (let i = 0; i < 40; i += 1) {
      const topic = ["all", "ctf", "src", "daily", "sys"][Math.floor(rand() * 5)];
      const to = [null, "cc", "dsh"][Math.floor(rand() * 3)];
      const limit = [1, 3, 10, 50][Math.floor(rand() * 4)];
      const sinceId = Math.floor(rand() * 1100);
      const all = store.readWindow();
      assert.deepEqual(
        ids(store.recent({ limit, topic, to }).messages),
        ids(oracleRecent(all, { limit, topic, to })),
      );
      assert.deepEqual(
        ids(store.since(sinceId, { limit, topic, to }).messages),
        ids(oracleSince(all, sinceId, { limit, topic, to })),
      );
      assert.equal(
        store.since(sinceId, { limit, topic, to }).oldestAvailableId,
        all.length ? all[0].id : store.lastId,
      );
    }
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("cache cap disables caching instead of returning a partial window", () => {
  const dir = makeTempDir();
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const store = new Store({
    dataDir: dir,
    now: () => now,
    logger: silentLogger,
    maxCacheBytes: 1,
  }).init();
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    store.append({ from: "cc", body: "one" });
    store.append({ from: "cc", body: "two" });
    fs.readFileSync = (...args) => {
      reads += 1;
      return originalRead.apply(fs, args);
    };
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2]);
    assert.deepEqual(ids(store.recent({ limit: 10 }).messages), [1, 2]);
    assert.ok(reads >= 2);
    assert.equal(store._window, null);
  } finally {
    fs.readFileSync = originalRead;
    store.close();
    cleanup(dir);
  }
});

test("lock is exclusive and reports a live owner", () => {
  const dir = makeTempDir();
  try {
    const lock = acquireLock(dir, { kill: () => {} });
    const payload = JSON.parse(fs.readFileSync(path.join(dir, "hub.lock"), "utf8"));
    assert.equal(payload.pid, process.pid);
    assert.ok(payload.started_at);

    assert.throws(
      () => acquireLock(dir, { kill: () => {} }),
      (err) => err.code === "LOCKED" && err.pid === process.pid,
    );
    lock.release();
    assert.equal(fs.existsSync(path.join(dir, "hub.lock")), false);
  } finally {
    cleanup(dir);
  }
});

test("stale lock is reclaimed only on ESRCH, EPERM stays locked", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "hub.lock");
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: "x" }));
    const stderr = new Error("gone");
    stderr.code = "ESRCH";
    const lock = acquireLock(dir, { kill: () => { throw stderr; } });
    lock.release();

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: "x" }));
    const eperm = new Error("denied");
    eperm.code = "EPERM";
    assert.throws(
      () => acquireLock(dir, { kill: () => { throw eperm; } }),
      (err) => err.code === "LOCKED",
    );
    fs.unlinkSync(lockPath);
  } finally {
    cleanup(dir);
  }
});
