// Built-in agent presets. Commands are templates, never arbitrary strings:
// {base} and {tokenFile} are substituted by the server; token values are never
// embedded. Only these presets may produce launch.mode:"local".
//
// `args` is what the Hub actually spawns (shell:false). `command` is the
// human-readable one-liner shown in the UI; env vars are rendered per platform.
// Provider credentials (RESPONDER_*_KEY / models) come from the environment
// the HUB process runs in — the launcher passes its own env through.

const RESPONDER = ["clients/responder.js", "run"];

export const PRESETS = Object.freeze([
  {
    id: "watcher-openai",
    name: "Watcher · OpenAI 兼容 API",
    description: "接任意 OpenAI 兼容 /chat/completions：OpenAI、DeepSeek、GLM、Moonshot、Ollama、LM Studio、vLLM、one-api",
    backend: "openai",
    identity: "watcher-openai",
    launch_mode: "local",
    command: "{node} clients/responder.js run --identity watcher-openai --backend openai",
    args: [...RESPONDER, "--identity", "watcher-openai", "--backend", "openai"],
    env: [
      { key: "MSGHUB_BASE", value: "{base}" },
      { key: "MSGHUB_TOKEN_FILE", value: "{tokenFile}" },
    ],
    capabilities: ["files", "tasks"],
    requirements: [
      "启动 Hub 的环境设置 RESPONDER_OPENAI_MODEL（必填，如 deepseek-chat）",
      "可选 RESPONDER_OPENAI_BASE（默认 https://api.openai.com/v1）",
      "可选 RESPONDER_OPENAI_KEY 或 RESPONDER_OPENAI_KEY_FILE（本地免鉴权服务可不设）",
    ],
  },
  {
    id: "watcher-anthropic",
    name: "Watcher · Anthropic API",
    description: "接 Anthropic Messages API（/v1/messages），或任何兼容代理",
    backend: "anthropic",
    identity: "watcher-anthropic",
    launch_mode: "local",
    command: "{node} clients/responder.js run --identity watcher-anthropic --backend anthropic",
    args: [...RESPONDER, "--identity", "watcher-anthropic", "--backend", "anthropic"],
    env: [
      { key: "MSGHUB_BASE", value: "{base}" },
      { key: "MSGHUB_TOKEN_FILE", value: "{tokenFile}" },
    ],
    capabilities: ["files", "tasks"],
    requirements: [
      "启动 Hub 的环境设置 RESPONDER_ANTHROPIC_MODEL（必填）",
      "可选 RESPONDER_ANTHROPIC_KEY 或 RESPONDER_ANTHROPIC_KEY_FILE",
      "可选 RESPONDER_ANTHROPIC_BASE / RESPONDER_ANTHROPIC_VERSION",
    ],
  },
  {
    id: "watcher-claude",
    name: "Watcher · Claude Code CLI",
    description: "本机 Claude Code CLI，受限无工具模式（--tools \"\" --safe-mode --restricted）",
    backend: "claude",
    identity: "watcher-claude",
    launch_mode: "local",
    command: "{node} clients/responder.js run --identity watcher-claude --backend claude",
    args: [...RESPONDER, "--identity", "watcher-claude", "--backend", "claude"],
    env: [
      { key: "MSGHUB_BASE", value: "{base}" },
      { key: "MSGHUB_TOKEN_FILE", value: "{tokenFile}" },
    ],
    capabilities: ["files", "tasks"],
    requirements: [
      "Claude Code CLI 可执行（PATH 里的 claude，或设 RESPONDER_CLAUDE_BIN）",
      "启动 Hub 的环境带 ANTHROPIC_*/CLAUDE_* 认证变量",
    ],
  },
  {
    id: "watcher-openclaw",
    name: "Watcher · OpenClaw",
    description: "本机 OpenClaw agent exec，钉死无工具配置与独立 state-dir",
    backend: "openclaw",
    identity: "watcher-openclaw",
    launch_mode: "local",
    command: "{node} clients/responder.js run --identity watcher-openclaw --backend openclaw",
    args: [...RESPONDER, "--identity", "watcher-openclaw", "--backend", "openclaw"],
    env: [
      { key: "MSGHUB_BASE", value: "{base}" },
      { key: "MSGHUB_TOKEN_FILE", value: "{tokenFile}" },
    ],
    capabilities: ["files", "tasks"],
    requirements: [
      "OPENCLAW_ENTRY 指向 openclaw.mjs（必填）",
      "OPENCLAW_MSGHUB_CONFIG 指向钉死的无工具配置（必填）",
      "RESPONDER_OPENCLAW_MODEL 必填（provider/model 形式）",
    ],
  },
]);

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function getPreset(id) {
  return BY_ID.get(id) ?? null;
}

export function isLocalPreset(id) {
  return BY_ID.get(id)?.launch_mode === "local";
}

function substitute(value, { base, tokenFile }) {
  return String(value).replaceAll("{base}", base).replaceAll("{tokenFile}", tokenFile);
}

// Server-side rendering of the visible command. The token is never included;
// only its file path is. Env prefixes are platform-appropriate so the string
// can actually be pasted into a terminal.
export function renderCommand(preset, {
  base = "http://127.0.0.1:18795",
  tokenFile = "data/token.txt",
  node = "node",
  platform = process.platform,
} = {}) {
  const vars = (preset.env ?? []).map(({ key, value }) => ({
    key,
    value: substitute(value, { base, tokenFile }),
  }));
  const main = substitute(preset.command ?? "", { base, tokenFile }).replaceAll("{node}", node);
  if (vars.length === 0) return main;
  if (platform === "win32") {
    const prefix = vars.map(({ key, value }) => `$env:${key}='${value}';`).join(" ");
    return `${prefix} ${main}`;
  }
  const prefix = vars.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join(" ");
  return `${prefix} ${main}`;
}
