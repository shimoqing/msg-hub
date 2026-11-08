import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProfileStore } from "../lib/profile.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msghub-profile-"));
}

test("profile starts empty and persists first write", () => {
  const dir = tmp();
  const file = path.join(dir, "profile.jsonl");
  const profile = createProfileStore({ file });
  assert.equal(profile.get(), null);
  profile.upsert({ operator: "youneiga", display_name: "youneiga" });
  assert.equal(profile.get().operator, "youneiga");
  assert.equal(profile.get().onboarded, false);
  profile.close();
  const reopened = createProfileStore({ file });
  assert.equal(reopened.get().display_name, "youneiga");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("upsert updates fields without losing onboarded", () => {
  const dir = tmp();
  const file = path.join(dir, "profile.jsonl");
  const profile = createProfileStore({ file });
  profile.upsert({ operator: "youneiga", display_name: "youneiga", onboarded: true });
  profile.upsert({ operator: "youneiga", display_name: "Yue" });
  assert.equal(profile.get().display_name, "Yue");
  assert.equal(profile.get().onboarded, true);
  profile.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile validates operator and display_name", () => {
  const dir = tmp();
  const file = path.join(dir, "profile.jsonl");
  const profile = createProfileStore({ file });
  assert.throws(() => profile.upsert({ operator: "BAD ID", display_name: "x" }), /invalid operator/);
  assert.throws(() => profile.upsert({ operator: "cc", display_name: "x".repeat(40) }), /invalid display_name/);
  assert.throws(() => profile.upsert({ operator: "cc", display_name: "x", onboarded: "yes" }), /invalid onboarded/);
  profile.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
