import fs from "node:fs";
import path from "node:path";
import { localDateKey, localIso } from "./store.js";

const pad2 = (n) => String(n).padStart(2, "0");

export function createLogger({
  logDir,
  maxBytes = 10 * 1024 * 1024,
  now = () => new Date(),
  prefix = "hub",
} = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  let fd = null;
  let currentKey = null;
  let currentFile = null;

  function closeFd() {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
  }

  function openFor(date) {
    currentKey = localDateKey(date);
    currentFile = path.join(logDir, `${prefix}-${currentKey}.log`);
    fd = fs.openSync(currentFile, "a");
  }

  function rotate(date) {
    const key = localDateKey(date);
    if (fd === null || key !== currentKey) {
      closeFd();
      openFor(date);
      return;
    }

    let size = 0;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      size = 0;
    }
    if (size < maxBytes) return;

    closeFd();
    const stamp =
      `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}` +
      `-${String(date.getMilliseconds()).padStart(3, "0")}`;
    let rotated = path.join(logDir, `${prefix}-${currentKey}-${stamp}.log`);
    let suffix = 1;
    while (fs.existsSync(rotated)) {
      rotated = path.join(logDir, `${prefix}-${currentKey}-${stamp}-${suffix}.log`);
      suffix += 1;
    }
    try {
      fs.renameSync(currentFile, rotated);
    } catch {
      /* if rename fails, keep appending to the same file */
    }
    openFor(date);
  }

  function write(line) {
    const date = now();
    try {
      rotate(date);
      fs.writeSync(fd, `${localIso(date)} ${line}\n`);
    } catch (err) {
      console.error(`[msg-hub logger] ${err.message}`);
    }
  }

  return {
    info: write,
    warn: write,
    error: write,
    close() {
      closeFd();
    },
  };
}
