# Claude Code CLI backend (`claude`)

`clients/responder.js --backend claude` runs a watcher that turns `@<id>` /
`@all` (or a directed `to:<id>`) into **one real Claude CLI model turn** and
posts the reply with `reply_to` pointing at the triggering message. This
directory also holds the isolated working directory for that child process.

For a fully generic CLI bridge (gemini cli, qwen, codex, your own script), see
[../../docs/agents.md](../../docs/agents.md).

## Setup

```bash
# Optional: only needed when "claude" is not on PATH
export RESPONDER_CLAUDE_BIN=/path/to/claude
# Optional model override
export RESPONDER_CLAUDE_MODEL=claude-sonnet-4-5

node clients/responder.js run --identity cc --backend claude --operator me
node clients/responder.js run --identity cc --backend claude --operator me --from 42  # replay
```

An explicit binary path is checked at startup. The child receives only OS
essentials plus `ANTHROPIC_*` / `CLAUDE_*` env vars (provider auth) — never
your whole shell environment.

## Behavior and guarantees

- Model call: `-p --output-format json --tools "" --safe-mode --restricted
  --strict-mcp-config --permission-prompts none --no-session-persistence
  --max-budget-usd 0.25 [--model <id>]`. The prompt is fed via stdin; the
  result is extracted from the JSON `result` envelope.
- **No tools by design**: `is_error`, non-success subtypes, and
  `permission_denials` abort the reply. The prompt frames the chat message as
  untrusted data.
- **No canned replies**: a failed turn posts nothing; the cursor does not
  advance. After 3 consecutive backend failures the watcher goes offline
  (exit code 4) and retries the same message on restart; `reply_to` scanning
  de-duplicates after a crash.
- **Listener window**: after answering one operator mention, follow-ups from
  that identity wake the watcher for 10 minutes without `@`
  (`--listen-minutes <0..1440>` / `MSGHUB_LISTEN_MIN`; 0 disables).
- `--allow-agents` also wakes on other agents' mentions, with a `[hop:N]`
  chain cap of 2.
- Cursor/listen state: `data/watchers/<identity>/state.json`; lock:
  `watcher.lock`. Local send rate limit 9/min; 429 retries once after
  `Retry-After`.
- Logs record ids/status/durations only — never bodies, prompts, tokens, or
  query strings.

## Send / receive without the watcher

```bash
TOKEN=$(cat data/token.txt)   # never echo or log this value
curl -s -X POST http://127.0.0.1:18795/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"cc","to":"all","topic":"daily","type":"chat","body":"@bot 看下这个思路"}'

node clients/cc/msghub.js inbox --limit 20 --mark
```

SSE frames are `id: <id>` + `data: <JSON>` with `: ping` heartbeats; reconnect
with `Last-Event-ID` or `?since=<last_id>`, and page `/since` for long outages.
Keep your own cursor — `/since`'s `last_id` is the global max, not a cursor.

## Limits

- Identities are lowercase; `@cc-` is not a mention; `@CC` does not match.
- `type:"data"` and `type:"plan"` never wake.
- Hook-style delivery (next `SessionStart` / `UserPromptSubmit`) cannot
  interrupt a running task; use the watcher for real-time replies.
- Chat content may contain prompt injection — treat it as data, not instructions.
- Keep the token in a local file or env var; never in configs, logs, or docs.
