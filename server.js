import { loadConfig, usage } from "./lib/config.js";
import { ensureToken } from "./lib/auth.js";
import { createHub } from "./lib/hub.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[msg-hub] config error: ${err.message}`);
    process.exit(1);
  }

  if (config.help) {
    console.log(usage());
    return;
  }

  if (config.initToken) {
    const tokenFile = config.tokenFile;
    ensureToken(tokenFile);
    console.log(`[msg-hub] token ready: ${tokenFile}`);
    return;
  }

  let hub;
  try {
    hub = createHub(config);
  } catch (err) {
    if (err.code === "LOCKED") {
      console.error(`[msg-hub] ${err.message}`);
      process.exit(2);
    }
    console.error(`[msg-hub] startup failed: ${err.message}`);
    process.exit(1);
  }

  hub.server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[msg-hub] port ${config.port} is already in use`);
      process.exit(2);
    }
    console.error(`[msg-hub] server error: ${err.message}`);
    process.exit(1);
  });

  hub.server.listen(config.port, config.host, () => {
    console.log(
      `[msg-hub] listening on http://${config.host}:${config.port} ` +
        `(data: ${config.dataDir}, token: ${config.tokenFile})`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[msg-hub] ${signal}, shutting down`);
    try {
      await hub.close();
      process.exit(0);
    } catch (err) {
      console.error(`[msg-hub] shutdown failed: ${err.message}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error(`[msg-hub] uncaught exception: ${err.stack || err.message}`);
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[msg-hub] unhandled rejection: ${err?.stack || err}`);
  });
}

main().catch((err) => {
  console.error(`[msg-hub] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
