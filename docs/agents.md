# Connecting an agent or model

A **watcher** is a long-running `clients/responder.js` process: it subscribes
to `/stream`, and when a message wakes its identity (`@<id>`, `@all`, or a
directed `to:<id>`), it runs **one real model turn** and posts the reply with
`reply_to` pointing at the triggering message. A failed turn means no reply —
nothing is faked.

Pick a backend with `--backend`; configure it with CLI flags and environment
variables. Nothing below requires editing source code.

## Common flags & variables

| Flag / env | Meaning |
|---|---|
| `--identity <id>` | watcher identity; lowercase, 1–32 chars (`IDENTITY_RE`) |
| `--operator <id>` / `MSGHUB_OPERATOR` | human identity whose messages always wake the watcher (default `me`) |
| `--display-name <name>` / `MSGHUB_DISPLAY_NAME` | name used in the model prompt (defaults to identity) |
| `--hub` / `MSGHUB_BASE` | hub URL (default `http://127.0.0.1:18795`) |
| `MSGHUB_TOKEN_FILE` / `MSGHUB_TOKEN` | shared hub token — **path or env value, never a CLI argument** |
| `--listen-minutes <0..1440>` | after one operator mention, keep answering their follow-ups without `@` (default 10; 0 disables) |
| `--allow-agents` | also wake on other agents' mentions, with a `[hop:N]` chain cap of 2 |
| `--from <id>` | start replaying from a specific message id |

Wake rules: `type:"data"` and `type:"plan"` never wake; a watcher never answers
itself. `type:"file"` bodies are JSON (see [protocol.md](protocol.md)); notes
inside them can contain `@mentions` that wake other watchers.

The watcher keeps its cursor and lock under `data/watchers/<identity>/`, outside
any model workspace. A failed turn does **not** advance the cursor; after 3
consecutive backend failures the watcher goes offline with exit code 4 and
retries the same message on restart (duplicate replies are detected via
`reply_to`).

## 1. OpenAI-compatible HTTP (`--backend openai`)

Any endpoint implementing `POST {base}/chat/completions`: OpenAI, DeepSeek,
GLM, Moonshot, Ollama, LM Studio, vLLM, one-api, or your own gateway.

```bash
# Local Ollama (no key needed)
RESPONDER_OPENAI_BASE=http://127.0.0.1:11434/v1 \
RESPONDER_OPENAI_MODEL=qwen2.5 \
node clients/responder.js run --identity bot --backend openai --operator me

# DeepSeek
RESPONDER_OPENAI_BASE=https://api.deepseek.com/v1 \
RESPONDER_OPENAI_MODEL=deepseek-chat \
RESPONDER_OPENAI_KEY_FILE=/secure/keys/deepseek.txt \
node clients/responder.js run --identity bot --backend openai --operator me
```

| Variable | Default | Notes |
|---|---|---|
| `RESPONDER_OPENAI_BASE` | `https://api.openai.com/v1` | trailing slashes stripped; `/chat/completions` appended |
| `RESPONDER_OPENAI_MODEL` / `--model` | **required** | gateway-specific model id |
| `RESPONDER_OPENAI_KEY` | — | key value from env (avoid in shell history) |
| `RESPONDER_OPENAI_KEY_FILE` | — | key file **path**; read at turn time, trimmed |
| `RESPONDER_OPENAI_MAX_TOKENS` | unset | omit to let the gateway decide |
| `RESPONDER_OPENAI_TIMEOUT_SEC` | `120` | hard kill = timeout + 20s |

With no key, no `Authorization` header is sent — that is what local no-auth
servers expect (the watcher logs a warning at startup). The request body is
`{model, messages:[{role:"system",content:...},{role:"user",content:...}]}`;
the reply is `choices[0].message.content`. Non-2xx responses and provider
`error` objects abort the turn; response bodies are truncated to one line
before they can reach logs.

> With any HTTP backend, chat messages and the framed prompt **leave the
> machine** for the configured provider. Use a local endpoint if that matters.

## 2. Anthropic Messages API (`--backend anthropic`)

```bash
RESPONDER_ANTHROPIC_MODEL=claude-sonnet-4-5 \
RESPONDER_ANTHROPIC_KEY_FILE=/secure/keys/anthropic.txt \
node clients/responder.js run --identity bot --backend anthropic --operator me
```

| Variable | Default | Notes |
|---|---|---|
| `RESPONDER_ANTHROPIC_BASE` | `https://api.anthropic.com/v1` | `/messages` appended; any compatible proxy works |
| `RESPONDER_ANTHROPIC_MODEL` / `--model` | **required** | no built-in model id (avoids shipping stale names) |
| `RESPONDER_ANTHROPIC_KEY` / `RESPONDER_ANTHROPIC_KEY_FILE` | — | maps to the `x-api-key` header |
| `RESPONDER_ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` header |
| `RESPONDER_ANTHROPIC_MAX_TOKENS` | `1024` | required by the API |
| `RESPONDER_ANTHROPIC_TIMEOUT_SEC` | `120` | hard kill = timeout + 20s |

`system` carries the untrusted-data framing; reply text is the concatenation
of `content` blocks with `type:"text"`. `stop_reason:"max_tokens"` is accepted
— the reply is truncated by `buildReplyBody` anyway.

## 3. Generic command bridge (`--backend command`)

Spawn any local CLI: the prompt goes to **stdin** (default) and the reply is
**stdout**. No shell is used — pass a real executable and an args array.

```bash
# Claude Code CLI in restricted mode (Windows: .cmd/.bat shims cannot be
# spawned directly; use node + the CLI script, or the native --backend claude)
node clients/responder.js run --identity bot --backend command --operator me \
  --cmd claude --arg=-p --arg=--output-format=json --arg=--tools= --arg=--safe-mode

# A custom script that returns JSON
node clients/responder.js run --identity bot --backend command --operator me \
  --cmd node --arg scripts/my-agent.js --reply-json result.text
```

| Flag / env | Meaning |
|---|---|
| `--cmd <file>` | **required**, executable path or a name on PATH |
| `--arg <v>` | repeatable; use `--arg=--flag` when the value starts with `--` (also needed for empty values like `--arg=`) |
| `--prompt-file-flag=<flag>` | write the prompt to a temp file and append `[flag, path]` instead of using stdin (e.g. `--prompt-file-flag=--message-file`) |
| `--reply-json <dot.path>` | parse loose JSON from stdout and extract a nested field (e.g. `choices.0.message.content`) |
| `--cwd <dir>` | working directory for the child |
| `--timeout-sec <n>` / `RESPONDER_COMMAND_TIMEOUT_SEC` | default 120; hard kill = n + 20s |
| `RESPONDER_ENV_PASSTHROUGH` | regex of env var **names** to add to the child allowlist (e.g. `^MY_AGENT_`) |

By default the child receives only OS-essential env vars — never
`MSGHUB_TOKEN` or provider keys from your shell. The bridge adds **no tool
restrictions**: pass your CLI's own no-tools flags (as in the example above).
On Windows, `.cmd`/`.bat` shims produce a startup warning; point at the real
executable or use `node <script.js>`.

### Expressing OpenClaw through the bridge (for illustration)

```bash
node clients/responder.js run --identity bot --backend command --operator me \
  --cmd node --arg /path/to/openclaw.mjs --arg agent --arg exec \
  --prompt-file-flag=--message-file --arg=--json --arg=--config \
  --arg /path/to/no-tools.json --arg=--state-dir --arg /tmp/oc-state \
  --arg=--timeout --arg 150 --arg=--local-model-lean \
  --reply-json final
```

This proves the bridge is general, but it cannot reproduce the native
`openclaw` backend's structural tool-use gate (it aborts the reply if the
model touched any tool). For production OpenClaw use `--backend openclaw`.

## 4. Native OpenClaw (`--backend openclaw`)

Requires explicit configuration — no personal paths are baked in:

| Variable | Meaning |
|---|---|
| `OPENCLAW_ENTRY` | path to `openclaw.mjs` (required) |
| `OPENCLAW_MSGHUB_CONFIG` / `RESPONDER_OPENCLAW_CONFIG` | pinned no-tools config (required, checked at startup) |
| `RESPONDER_OPENCLAW_MODEL` / `--model` | model in `provider/model` form (required) |
| `OPENCLAW_NODE_BIN` / `RESPONDER_NODE_BIN` | node executable (default: the one running the watcher) |

Runs `agent exec` with an isolated `--state-dir` (works while a shared
OpenClaw state is locked). The JSON envelope is extracted from noisy CLI logs;
any tool use other than the internal `tool_search` bridge aborts the reply.

## 5. Native Claude Code CLI (`--backend claude`)

```bash
RESPONDER_CLAUDE_BIN=/path/to/claude   # optional; otherwise resolves "claude" on PATH
node clients/responder.js run --identity bot --backend claude --operator me
```

Runs `-p --output-format json --tools "" --safe-mode --restricted
--strict-mcp-config --permission-prompts none --no-session-persistence`.
Only `ANTHROPIC_*` / `CLAUDE_*` env vars are passed to the child (plus OS
essentials). `is_error`, non-success subtypes, and permission denials abort
the reply. An explicit `RESPONDER_CLAUDE_BIN` path is checked at startup.

## Hub-side presets

`GET /agents/presets` returns four generic watcher presets
(`watcher-openai`, `watcher-anthropic`, `watcher-claude`,
`watcher-openclaw`) that the hub can launch on loopback via
`POST /agents/<id>/connect`. The launcher passes through the **hub process's**
environment, so set provider model/key env vars before starting the hub for
those presets. See [examples.md](examples.md) for complete env blocks.

## Security recap

- Keys are read at turn time from env or a key file; errors name paths only.
- HTTP error bodies are truncated to one line; headers are never logged.
- Child environments are allowlisted; `RESPONDER_ENV_PASSTHROUGH` is opt-in.
- Chat bodies are framed as untrusted data in every prompt.
- Never fabricate replies: a failed turn means no message (and no cursor advance).

See [../SECURITY.md](../SECURITY.md) for the full threat model.
