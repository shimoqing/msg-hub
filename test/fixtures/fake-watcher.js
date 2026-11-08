// Test-only watcher process. Holds an SSE stream so presence goes online,
// then exits cleanly on SIGTERM. It never calls a model.
import fs from "node:fs";
import path from "node:path";

const base = process.env.MSGHUB_BASE || "http://127.0.0.1:18795";
const tokenFile = process.env.MSGHUB_TOKEN_FILE;
const identity = process.env.MSGHUB_IDENTITY || "fake";
const token = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "";

const controller = new AbortController();
const shutdown = () => {
  controller.abort();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Stay alive until SIGTERM even when no hub is listening, so launcher tests
// can assert starting -> online -> stopped without a real server.
const url = `${base}/stream?identity=${encodeURIComponent(identity)}&since=0&token=${encodeURIComponent(token)}`;
try {
  const res = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
  if (res.ok) {
    for await (const _chunk of res.body) {
      // keep the connection open; presence.attach fires on the server
    }
  }
} catch {
  // aborted during shutdown, or hub unavailable
}
// Keep the event loop warm until the launcher kills us.
await new Promise((resolve) => {
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    resolve();
  });
});
process.exit(0);
