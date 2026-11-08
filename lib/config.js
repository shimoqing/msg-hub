import path from "node:path";

export const DEFAULTS = Object.freeze({
  port: 18795,
  host: "127.0.0.1",
  topics: ["ctf", "src", "daily", "sys"],
  ratePerMin: 10,
  bodyLimit: 64 * 1024,
  sseMax: 50,
  replayMax: 1000,
  retentionDays: 2,
  cacheMaxMessages: 150000,
  cacheMaxBytes: 64 * 1024 * 1024,
  allowedCidrs: ["127.0.0.1/32", "::1/128"],
  logMaxBytes: 10 * 1024 * 1024,
  filesMaxBytes: 20 * 1024 * 1024,
});

function parseIntStrict(name, raw, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return n;
}

function parseCsv(raw) {
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// RFC1918 private ranges, added by --allow-lan on top of loopback.
const LAN_CIDRS = Object.freeze(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--port":
        out.port = next();
        break;
      case "--host":
        out.host = next();
        break;
      case "--data-dir":
        out.dataDir = next();
        break;
      case "--token-file":
        out.tokenFile = next();
        break;
      case "--log-dir":
        out.logDir = next();
        break;
      case "--topics":
        out.topics = parseCsv(next());
        break;
      case "--allow-lan":
        out.allowLan = true;
        break;
      case "--init-token":
        out.initToken = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

export function loadConfig({ env = process.env, argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const cli = parseArgs(argv);
  const dataDir = path.resolve(cwd, cli.dataDir ?? env.MSGHUB_DATA_DIR ?? "data");
  const tokenFile = path.resolve(
    cwd,
    cli.tokenFile ?? env.MSGHUB_TOKEN_FILE ?? path.join(dataDir, "token.txt"),
  );
  const logDir = path.resolve(
    cwd,
    cli.logDir ?? env.MSGHUB_LOG_DIR ?? path.join(dataDir, "logs"),
  );
  const registryFile = (name) => path.resolve(cwd, env[`MSGHUB_${name}_FILE`] ?? path.join(dataDir, `${name.toLowerCase()}.jsonl`));

  const config = {
    ...DEFAULTS,
    port: parseIntStrict("port", cli.port ?? env.MSGHUB_PORT ?? DEFAULTS.port, 0, 65535),
    host: cli.host ?? env.MSGHUB_HOST ?? DEFAULTS.host,
    dataDir,
    tokenFile,
    logDir,
    agentsFile: registryFile("AGENTS"),
    groupsFile: registryFile("GROUPS"),
    plansFile: registryFile("PLANS"),
    profileFile: registryFile("PROFILE"),
    contextsFile: registryFile("CONTEXTS"),
    topics: cli.topics ?? (env.MSGHUB_TOPICS ? parseCsv(env.MSGHUB_TOPICS) : DEFAULTS.topics),
    ratePerMin: parseIntStrict(
      "ratePerMin",
      env.MSGHUB_RATE_PER_MIN ?? DEFAULTS.ratePerMin,
      1,
      100000,
    ),
    bodyLimit: parseIntStrict(
      "bodyLimit",
      env.MSGHUB_BODY_LIMIT ?? DEFAULTS.bodyLimit,
      1,
      16 * 1024 * 1024,
    ),
    sseMax: parseIntStrict("sseMax", env.MSGHUB_SSE_MAX ?? DEFAULTS.sseMax, 1, 10000),
    replayMax: parseIntStrict(
      "replayMax",
      env.MSGHUB_REPLAY_MAX ?? DEFAULTS.replayMax,
      1,
      100000,
    ),
    retentionDays: parseIntStrict(
      "retentionDays",
      env.MSGHUB_RETENTION_DAYS ?? DEFAULTS.retentionDays,
      1,
      365,
    ),
    cacheMaxMessages: parseIntStrict(
      "cacheMaxMessages",
      env.MSGHUB_CACHE_MAX_MESSAGES ?? DEFAULTS.cacheMaxMessages,
      0,
      10_000_000,
    ),
    cacheMaxBytes: parseIntStrict(
      "cacheMaxBytes",
      env.MSGHUB_CACHE_MAX_BYTES ?? DEFAULTS.cacheMaxBytes,
      0,
      1024 * 1024 * 1024,
    ),
    allowedCidrs: cli.allowLan
      ? [...DEFAULTS.allowedCidrs, ...LAN_CIDRS]
      : env.MSGHUB_ALLOWED_CIDRS
        ? parseCsv(env.MSGHUB_ALLOWED_CIDRS)
        : DEFAULTS.allowedCidrs,
    filesMaxBytes: parseIntStrict(
      "filesMaxBytes",
      env.MSGHUB_FILES_MAX_BYTES ?? DEFAULTS.filesMaxBytes,
      1,
      1024 * 1024 * 1024,
    ),
    logMaxBytes: parseIntStrict(
      "logMaxBytes",
      env.MSGHUB_LOG_MAX_BYTES ?? DEFAULTS.logMaxBytes,
      1024,
      1024 * 1024 * 1024,
    ),
    initToken: Boolean(cli.initToken),
    help: Boolean(cli.help),
  };

  if (!config.topics.length) {
    throw new Error("topics must not be empty");
  }
  if (!config.allowedCidrs.length) {
    throw new Error("allowedCidrs must not be empty");
  }
  return config;
}

export function usage() {
  return [
    "msg-hub [options]",
    "  --port <n>          listen port (default 18795)",
    "  --host <addr>       bind address (default 127.0.0.1; 0.0.0.0 for LAN)",
    "  --data-dir <path>   JSONL data directory (default ./data)",
    "  --token-file <path> token file (default <data-dir>/token.txt)",
    "  --log-dir <path>    access log directory (default <data-dir>/logs)",
    "  --topics <csv>      allowed topics (default ctf,src,daily,sys)",
    "  --allow-lan         allow RFC1918 private ranges in addition to loopback",
    "                      (or set MSGHUB_ALLOWED_CIDRS for an explicit list)",
    "  --init-token        generate token then exit",
    "  -h, --help          show this help",
  ].join("\n");
}
