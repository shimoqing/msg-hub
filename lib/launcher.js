// Local watcher launcher. Hub only starts/stops processes; it never runs a
// model turn. Strict boundaries:
//   - loopback callers only (enforced by the hub route)
//   - built-in local presets only; spawn with an args array, shell:false
//   - one process per agent; only Hub-started processes can be disconnected
//   - token is passed as a FILE PATH, never as a value
//   - console output goes to data/watchers/<id>/console.log (path only in UI)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPreset, isLocalPreset } from "./presets.js";
import { IDENTITY_RE } from "./protocol.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function watcherDir(dataDir, id) {
  return path.join(dataDir, "watchers", id);
}

function treeKill(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  if (process.platform === "win32") {
    try {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

export function createLauncher({
  dataDir,
  tokenFile,
  base = "http://127.0.0.1:18795",
  nodeBin = process.execPath,
  logger = console,
  platform = process.platform,
} = {}) {
  const running = new Map(); // id -> { child, preset, started_at, logPath }

  function status(id) {
    const entry = running.get(id);
    if (!entry) return null;
    return {
      state: entry.child.exitCode === null ? "online" : "error",
      pid: entry.child.pid ?? null,
      exit_code: entry.child.exitCode,
      started_at: entry.started_at,
      started_by: "hub",
      log_path: entry.logPath,
    };
  }

  function start(id, { loopback = true } = {}) {
    if (!IDENTITY_RE.test(id ?? "")) {
      throw Object.assign(new Error("invalid agent id"), { code: "BAD_INPUT" });
    }
    if (!loopback) throw Object.assign(new Error("local launch requires loopback"), { code: "FORBIDDEN" });
    if (running.has(id)) throw Object.assign(new Error("agent already has a Hub-started process"), { code: "CONFLICT" });
    if (!isLocalPreset(id)) throw Object.assign(new Error("agent has no built-in local preset"), { code: "BAD_INPUT" });
    const preset = getPreset(id);
    const dir = watcherDir(dataDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "console.log");
    const logFd = fs.openSync(logPath, "a");

    const presetEnv = {};
    for (const { key, value } of preset.env ?? []) {
      presetEnv[key] = String(value)
        .replaceAll("{base}", base)
        .replaceAll("{tokenFile}", tokenFile);
    }
    const child = spawn(nodeBin, preset.args, {
      cwd: PROJECT_ROOT,
      shell: false,
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...presetEnv,
        MSGHUB_IDENTITY: id,
      },
    });
    // fd is duplicated into the child; the parent can close its copy.
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }

    const entry = {
      child,
      preset,
      started_at: new Date().toISOString(),
      logPath,
    };
    running.set(id, entry);
    child.on("exit", (code, signal) => {
      logger.info(`watcher ${id} exit=${code} signal=${signal ?? ""} log=${logPath}`);
      if (running.get(id) === entry) running.delete(id);
    });
    child.on("error", (err) => {
      logger.error(`watcher ${id} spawn error: ${err.message}`);
      if (running.get(id) === entry) running.delete(id);
    });
    return { state: "starting", pid: child.pid ?? null, log_path: logPath };
  }

  function stop(id) {
    const entry = running.get(id);
    if (!entry) throw Object.assign(new Error("agent has no Hub-started process"), { code: "NOT_FOUND" });
    running.delete(id);
    treeKill(entry.child);
    return { state: "stopping", pid: entry.child.pid ?? null };
  }

  function stopAll() {
    for (const id of [...running.keys()]) {
      try {
        stop(id);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    start,
    stop,
    stopAll,
    status,
    get size() {
      return running.size;
    },
    has(id) {
      return running.has(id);
    },
  };
}
