import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createFileStore, sanitizeFileName } from "../lib/files.js";
import { createHub } from "../lib/hub.js";

// ---------- unit: createFileStore ----------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-files-"));
}

test("sanitizeFileName strips paths, control chars, and falls back", () => {
  assert.equal(sanitizeFileName("report.pdf"), "report.pdf");
  assert.equal(sanitizeFileName("..\\..\\evil.exe"), "evil.exe");
  assert.equal(sanitizeFileName("/etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("a/b/c.txt"), "c.txt");
  assert.equal(sanitizeFileName("we\nird　na me.txt"), "weird　na me.txt");
  assert.equal(sanitizeFileName(""), "file.bin");
  assert.equal(sanitizeFileName("..."), "file.bin");
  assert.equal(sanitizeFileName("口 娃").length > 0, true);
});

test("fileStore: put writes bytes, records metadata, get/list round-trip", () => {
  const dir = tmpDir();
  const store = createFileStore({ dir, now: () => 1_000 });
  const bytes = Buffer.from("hello handoff 你好");
  const file = store.put({ name: "交接说明.txt", bytes, by: "cc" });

  assert.ok(file.id.startsWith("f"));
  assert.equal(file.name, "交接说明.txt");
  assert.equal(file.size, bytes.length);
  assert.equal(file.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(file.by, "cc");
  assert.equal(file.path, path.join(dir, `${file.id}.bin`));
  assert.ok(fs.existsSync(file.path));

  const got = store.get(file.id);
  assert.equal(got.name, "交接说明.txt");
  assert.equal(got.abs, file.path);
  assert.deepEqual(store.list().map((f) => f.id), [file.id]);
});

test("fileStore: index survives restart and rejects unknown ids", () => {
  const dir = tmpDir();
  const first = createFileStore({ dir });
  const file = first.put({ name: "a.txt", bytes: Buffer.from("A"), by: "cc" });

  const second = createFileStore({ dir });
  assert.equal(second.get(file.id).name, "a.txt");
  assert.equal(second.get("f-nope"), null);
});

test("fileStore: put refuses oversized bytes and bad names", () => {
  const dir = tmpDir();
  const store = createFileStore({ dir, maxBytes: 8 });
  assert.throws(() => store.put({ name: "big.bin", bytes: Buffer.alloc(9), by: "cc" }), /exceeds 8 bytes/);
  assert.throws(() => store.put({ name: "x", bytes: null, by: "cc" }));
});

// ---------- HTTP: hub routes ----------

function makeConfig(dir) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    tokenFile: path.join(dir, "data", "token.txt"),
    logDir: path.join(dir, "data", "logs"),
    topics: ["daily"],
    ratePerMin: 1000,
    bodyLimit: 64 * 1024,
    sseMax: 10,
    replayMax: 1000,
    retentionDays: 2,
    allowedCidrs: ["127.0.0.1/32", "::1/128"],
    logMaxBytes: 10 * 1024 * 1024,
  };
}

function listen(hub) {
  return new Promise((resolve) => {
    hub.server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${hub.server.address().port}`);
    });
  });
}

async function startHub(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-files-hub-"));
  const config = { ...makeConfig(dir), ...overrides };
  const hub = createHub(config);
  const base = await listen(hub);
  return { base, token: hub.token, hub, async close() { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function request(base, pathname, { method = "GET", token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    const req = http.request(new URL(pathname, base), { method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, text, buf, headers: res.headers, json: () => json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("upload → send type file → download round-trip", async () => {
  const ctx = await startHub();
  try {
    const bytes = Buffer.from("交接文件内容 handoff-bytes");
    const up = await request(ctx.base, `/files/upload?name=${encodeURIComponent("方案.md")}&from=youneiga`, {
      method: "POST",
      token: ctx.token,
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    assert.equal(up.status, 201);
    const file = up.json().file;
    assert.equal(file.name, "方案.md");
    assert.equal(file.size, bytes.length);
    assert.ok(file.id.startsWith("f"));

    // /send with type file requires a matching upload record
    const bad = await request(ctx.base, "/send", {
      method: "POST",
      token: ctx.token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "cc", topic: "daily", type: "file", body: JSON.stringify({ id: "f-none", name: "x" }) }),
    });
    assert.equal(bad.status, 400);

    const sent = await request(ctx.base, "/send", {
      method: "POST",
      token: ctx.token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "cc",
        topic: "daily",
        type: "file",
        body: JSON.stringify({ id: file.id, name: file.name, size: file.size, note: "@yao 请查收" }),
      }),
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.json().message.type, "file");

    const down = await request(ctx.base, `/files/${file.id}`, { token: ctx.token });
    assert.equal(down.status, 200);
    assert.ok(down.buf.equals(bytes));
    assert.match(down.headers["content-disposition"], /UTF-8''/);

    const list = await request(ctx.base, "/files", { token: ctx.token });
    assert.equal(list.status, 200);
    assert.equal(list.json().files.length, 1);
  } finally {
    await ctx.close();
  }
});

test("upload requires auth, caps size, rejects empty name", async () => {
  const ctx = await startHub({ filesMaxBytes: 16 });
  try {
    const noAuth = await request(ctx.base, "/files/upload?name=a.txt", {
      method: "POST",
      body: "x",
    });
    assert.equal(noAuth.status, 401);

    const tooBig = await request(ctx.base, "/files/upload?name=a.txt", {
      method: "POST",
      token: ctx.token,
      body: Buffer.alloc(17),
    });
    assert.equal(tooBig.status, 413);

    const empty = await request(ctx.base, "/files/upload?name=", {
      method: "POST",
      token: ctx.token,
      body: "x",
    });
    assert.equal(empty.status, 400);

    const noName = await request(ctx.base, "/files/upload", {
      method: "POST",
      token: ctx.token,
      body: "x",
    });
    assert.equal(noName.status, 400);
  } finally {
    await ctx.close();
  }
});

test("download: unknown id 404, deleted bytes 410", async () => {
  const ctx = await startHub();
  try {
    const miss = await request(ctx.base, "/files/f-nope", { token: ctx.token });
    assert.equal(miss.status, 404);

    const up = await request(ctx.base, "/files/upload?name=a.txt", {
      method: "POST",
      token: ctx.token,
      body: "data",
    });
    const file = up.json().file;
    fs.rmSync(file.path);
    const gone = await request(ctx.base, `/files/${file.id}`, { token: ctx.token });
    assert.equal(gone.status, 410);
  } finally {
    await ctx.close();
  }
});

test("GET /files requires a token like the rest of the API", async () => {
  const ctx = await startHub();
  try {
    assert.equal((await request(ctx.base, "/files")).status, 401);
    assert.equal((await request(ctx.base, "/files/f-x")).status, 401);
  } finally {
    await ctx.close();
  }
});
