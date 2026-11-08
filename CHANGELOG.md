# Changelog

## 0.5.0 — 2026-11-08

First public open-source release.

### Universal AI/agent connection layer

`clients/responder.js` no longer hardcodes two backends. Five plug in via
`clients/backends.js`, selected with `--backend` and configured purely through
CLI flags + environment variables:

- `openai` — any OpenAI-compatible `POST {base}/chat/completions` endpoint:
  OpenAI, DeepSeek, GLM, Moonshot, Ollama, LM Studio, vLLM, one-api gateways.
- `anthropic` — Anthropic Messages API (`POST {base}/v1/messages`).
- `command` — generic bridge to any local CLI agent (claude code, gemini cli,
  qwen, codex, custom scripts): prompt via stdin or a prompt file, reply from
  stdout, optional `--reply-json <dot.path>` extraction.
- `openclaw`, `claude` — the original backends, behavior preserved.

Security posture: child environments stay allowlisted (`RESPONDER_ENV_PASSTHROUGH`
opts selected variables in for `command`); API keys are read at turn time from
env vars or key files (`RESPONDER_*_KEY_FILE`) and never enter code, logs, or
error strings; HTTP error bodies are truncated to one line before logging.

### Breaking changes vs the pre-open-source tree

- Hub binds `127.0.0.1` by default (was `0.0.0.0`); CIDR allowlist is
  loopback-only by default. Use `--allow-lan` (RFC1918) or `MSGHUB_ALLOWED_CIDRS`
  for LAN setups.
- All personal paths/identities removed from defaults:
  - openclaw backend requires `OPENCLAW_ENTRY`, `OPENCLAW_MSGHUB_CONFIG`, and
    `RESPONDER_OPENCLAW_MODEL` explicitly (no built-in defaults).
  - claude backend resolves `claude` from PATH unless `RESPONDER_CLAUDE_BIN` is set.
  - responder operator defaults to `me` (was a personal identity); override with
    `--operator <id>` or `MSGHUB_OPERATOR`.
  - Web UI identity starts empty instead of a preset name.
- Presets are generic watchers (`watcher-openai`, `watcher-anthropic`,
  `watcher-claude`, `watcher-openclaw`).

### Packaging

MIT `LICENSE`, bilingual README (EN + zh-CN), `SECURITY.md`, `CONTRIBUTING.md`,
`docs/` (agent connection guide, protocol reference, LAN setup example),
GitHub Actions CI on Node 24, `scripts/setup.mjs` + `scripts/doctor.mjs`, and a
hygiene test that keeps personal paths, identities, and token values out of the
repository.

### Earlier (pre-open-source, 0.1–0.4)

SSE hub with append-only JSONL truth source, Web UI, file handoff messages,
presence, reply receipts, watcher locks/cursor/retry semantics, agent/group/
plan registries, DM, local watcher launcher, context audit. See git history.
