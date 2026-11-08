import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRateLimiter,
  ensureToken,
  extractToken,
  isAddressAllowed,
  isAuthorized,
  parseCidr,
  tokenMatches,
} from "../lib/auth.js";

test("ensureToken creates a token once and reuses it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghub-auth-"));
  const file = path.join(dir, "nested", "token.txt");
  try {
    const token = ensureToken(file);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(file, "utf8").trim(), token);
    assert.equal(ensureToken(file), token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("token comparison is exact", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "abc "), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(null, "abc"), false);
});

test("extractToken reads Bearer and query tokens", () => {
  const url = new URL("http://localhost/stream?token=from-query");
  assert.equal(extractToken({ headers: { authorization: "Bearer from-header" } }, url), "from-header");
  assert.equal(extractToken({ headers: {} }, url), "from-query");
  assert.equal(extractToken({ headers: {} }, new URL("http://localhost/stream")), null);
  assert.equal(
    isAuthorized({ headers: { authorization: "bearer abc" } }, new URL("http://localhost/"), "abc"),
    true,
  );
  assert.equal(isAuthorized({ headers: {} }, url, "from-query"), true);
  assert.equal(isAuthorized({ headers: {} }, url, "other"), false);
});

test("parseCidr understands IPv4, ::1, and mapped IPv4", () => {
  assert.deepEqual(parseCidr("192.168.221.0/24"), {
    kind: "v4",
    network: 0xc0a8dd00,
    prefix: 24,
  });
  assert.deepEqual(parseCidr("::1/128"), { kind: "exact", value: "::1" });
  assert.deepEqual(parseCidr("::ffff:192.168.221.0/120"), {
    kind: "v4",
    network: 0xc0a8dd00,
    prefix: 24,
  });
  assert.equal(parseCidr("192.168.221.0/33"), null);
  assert.equal(parseCidr("::1/64"), null);
  assert.equal(parseCidr("not-an-ip/24"), null);
});

test("isAddressAllowed handles loopback, VMnet, and mapped addresses", () => {
  const allowed = ["127.0.0.1/32", "::1/128", "192.168.221.0/24"];
  assert.equal(isAddressAllowed("127.0.0.1", allowed), true);
  assert.equal(isAddressAllowed("::1", allowed), true);
  assert.equal(isAddressAllowed("::ffff:127.0.0.1", allowed), true);
  assert.equal(isAddressAllowed("192.168.221.159", allowed), true);
  assert.equal(isAddressAllowed("::ffff:192.168.221.159", allowed), true);
  assert.equal(isAddressAllowed("192.168.222.1", allowed), false);
  assert.equal(isAddressAllowed("10.0.0.5", allowed), false);
  assert.equal(isAddressAllowed(undefined, allowed), false);
  assert.equal(isAddressAllowed("127.0.0.1", []), false);
});

test("rate limiter allows perMin then blocks with Retry-After", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ perMin: 3, now: () => now });
  assert.equal(limiter.check("cc").allowed, true);
  assert.equal(limiter.check("cc").allowed, true);
  assert.equal(limiter.check("cc").allowed, true);
  const denied = limiter.check("cc");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 60);

  assert.equal(limiter.check("dsh").allowed, true);
  now += 60_001;
  assert.equal(limiter.check("cc").allowed, true);
});
