# msg-hub

A minimal multi-agent chat hub: real-time SSE + append-only JSONL, **zero npm dependencies**, Node 24 built-ins only. Bring any AI model or CLI agent into one chat room without editing source code.

[中文文档](README.zh-CN.md) · [Agent connection guide](docs/agents.md) · [Protocol reference](docs/protocol.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Why

Agent frameworks disagree about everything except a text message. msg-hub is the thin shared line: a browser UI, a JSONL event log, and watchers that turn `@mentions` into **real model turns**. The `clients/backends.js` registry lets you plug in:

- **OpenAI-compatible HTTP** — OpenAI, DeepSeek, GLM, Moonshot, Ollama, LM Studio, vLLM, one-api, or any `/chat/completions` gateway
- **Anthropic API** — `/v1/messages`
- **Generic command bridge** — any local CLI agent (claude code, gemini cli, qwen, codex, your own script): prompt via stdin, reply from stdout
- **OpenClaw / Claude Code CLI** — the original backends, unchanged in behavior

Different people have different setups; configuration is CLI flags + environment variables, never source edits.

## 3-minute quick start

Requires Node.js 24+.

```bash
node scripts/setup.mjs     # checks Node, creates data/token.txt (never prints its value)
node server.js             # listens on http://127.0.0.1:18795
```

Open <http://127.0.0.1:18795/> — loopback requests get the token injected automatically; other addresses show a token prompt. Then connect a watcher, for example a local Ollama model:

```bash
RESPONDER_OPENAI_BASE=http://127.0.0.1:11434/v1 \
RESPONDER_OPENAI_MODEL=qwen2.5 \
node clients/responder.js run --identity bot --backend openai --operator me
```

In the chat: `@bot hello` → a real model turn → a real reply (`reply_to` points at your message). See [docs/agents.md](docs/agents.md) for all backends and [docs/examples.md](docs/examples.md) for copy-paste recipes.

## Architecture

```
Browser / CLI clients / watchers
        │  HTTP + SSE (Bearer token)
┌───────┴────────────────────────────────────────┐
│  server.js (Node 24, loopback by default)       │
│    POST /send → validate → append+fsync → SSE   │
│    GET /stream, /messages, /since/<id>          │
│    registries: agents/groups/plans/profile/...  │
└────────────────────────────────────────────────┘
        │
  data/chat-YYYY-MM-DD.jsonl  ← single source of truth
```

- Messages are written (`write` + `fsync`) **before** broadcast. The last valid id is recovered from JSONL only — no `state.json`.
- All state lives in `data/` (gitignored). The whole directory is portable.
- Identity, topic, and message-type validation live in one place (`lib/protocol.js`); clients interpret `@` wake rules, the server does not.
- Chat content is untrusted data: watcher prompts frame messages as data, and the built-in CLI backends enforce no-tools execution.

## Configuration

CLI flags: `node server.js --help`. Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `MSGHUB_PORT` | `18795` | listen port |
| `MSGHUB_HOST` | `127.0.0.1` | bind address (`0.0.0.0` for LAN) |
| `MSGHUB_ALLOWED_CIDRS` | `127.0.0.1/32,::1/128` | app-level source allowlist; `--allow-lan` adds RFC1918 ranges |
| `MSGHUB_DATA_DIR` | `./data` | JSONL, token, lock files |
| `MSGHUB_TOKEN_FILE` | `<data>/token.txt` | shared token file (path only) |
| `MSGHUB_TOKEN` | — | token value override (for clients) |
| `MSGHUB_TOPICS` | `ctf,src,daily,sys` | built-in topics |
| `MSGHUB_RATE_PER_MIN` | `10` | per-`from` send limit |
| `MSGHUB_BODY_LIMIT` | `65536` | max body bytes |
| `MSGHUB_RETENTION_DAYS` | `2` | read window |
| `MSGHUB_FILES_MAX_BYTES` | `20971520` | upload limit |
| `MSGHUB_LOG_DIR`, `MSGHUB_SSE_MAX`, `MSGHUB_REPLAY_MAX`, `MSGHUB_CACHE_MAX_MESSAGES`, `MSGHUB_CACHE_MAX_BYTES`, `MSGHUB_LOG_MAX_BYTES` | see `--help` | tuning |

Responder-side variables are documented in [docs/agents.md](docs/agents.md); every API key has a `*_KEY_FILE` variant so secrets stay in files, never in commands or logs.

## HTTP API (summary)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | no | `{ok,version,uptime_s,last_id,sse_clients}` |
| GET | `/state` | yes | profile + agents + groups + plans + server |
| GET | `/stream` | yes | SSE (`since`, `topic`, `to`, `identity`; `Last-Event-ID` supported) |
| GET | `/since/<id>` | yes | messages after id |
| GET | `/messages` | yes | recent messages (`limit`, `topic`, `to`, `type`) |
| POST | `/send` | yes | publish a message |
| GET/POST | `/presence` | yes | presence snapshot/update |
| GET/POST | `/agents`, `/agents/presets`, `/agents/register`, `/agents/<id>/context` | yes | partner registry |
| GET/POST | `/groups`, `/plans`, `/profile` | yes | dynamic topics, plans, local profile |
| POST | `/files/upload`, GET `/files/<id>` | yes | file handoff (bytes on disk, small JSON references in chat) |
| GET | `/`, `/app.js`, `/style.css` | no | Web UI; token injected for loopback only |

Full shapes and semantics: [docs/protocol.md](docs/protocol.md). Errors are uniformly `{"ok":false,"error":{"code":"...","message":"..."}}`.

## Security model (short version)

- **Shared Bearer token**: anyone holding it can send as any `from`. No per-user auth, no roles.
- **Loopback by default**: LAN requires explicit `--host 0.0.0.0 --allow-lan` (or `MSGHUB_ALLOWED_CIDRS`) and your own firewall rule. No TLS; do not expose directly to the internet.
- **Keys never in the repo**: `data/`, `config.local.*`, `.claude/settings.json` are gitignored; access logs record paths only, never query strings.
- **HTTP backends send prompts off-machine** — use a local endpoint if that matters. `command` adds no tool restrictions; restrict via your CLI's own flags.

Read [SECURITY.md](SECURITY.md) before deploying.

## Tests & tools

```bash
npm test                          # node --test test/*.test.js
node bench/ui-bench.js --check    # UI perf invariants (local Chrome required)
node scripts/doctor.mjs           # runtime self-check
node --test test/hygiene.test.js  # no personal paths / secrets in tracked files
```

CI runs `npm test` on Windows and Ubuntu with Node 24.

## License

MIT — see [LICENSE](LICENSE).
