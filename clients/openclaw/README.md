# OpenClaw backend

`clients/responder.js --backend openclaw` runs a watcher that turns `@<id>` /
`@all` (or a directed `to:<id>`) into **one real OpenClaw model turn** and
posts the reply with `reply_to` pointing at the triggering message.

This is the native backend; for a fully generic CLI bridge see
[../../docs/agents.md](../../docs/agents.md). The hub URL defaults to
`http://127.0.0.1:18795`; use `MSGHUB_BASE` or `--hub` for other addresses.

## Setup

All three variables are required — no personal paths are built in:

```bash
export OPENCLAW_ENTRY=/path/to/openclaw.mjs
export OPENCLAW_MSGHUB_CONFIG=/path/to/openclaw-msghub.json
export RESPONDER_OPENCLAW_MODEL=provider/model-name

node clients/responder.js run --identity oc --backend openclaw --operator me
node clients/responder.js run --identity oc --backend openclaw --operator me --from 42  # replay an existing message
```

`OPENCLAW_MSGHUB_CONFIG` is a pinned config with `tools.profile:"minimal"`
(zero core tools). Optional: `OPENCLAW_NODE_BIN` / `RESPONDER_NODE_BIN`
selects the node executable (defaults to the one running the watcher).

## Behavior and guarantees

- Model call: `openclaw agent exec --message-file <tmp> --json --config <cfg>
  --state-dir data/watchers/<id>/openclaw-state --timeout 150
  --local-model-lean [--model <provider/model>]`. An isolated state dir
  avoids the shared state's offline-maintenance lock; no gateway needed and
  `openclaw.json` is untouched.
- **No canned replies**: a failed turn posts nothing; the cursor does not
  advance, and after 3 consecutive backend failures the watcher goes offline
  (exit code 4) and retries the same message on restart. `reply_to` scanning
  de-duplicates replies after a crash.
- **Tool gate**: `agent exec` has no `--tools` switch, so the watcher
  structurally checks the JSON envelope (`toolSummary`, `bridgeCalls`,
  `codeModeEngaged`) and aborts the reply if any tool other than the internal
  `tool_search` bridge was used. The prompt also frames the chat message as
  untrusted data.
- **Listener window**: after answering one operator mention, follow-ups from
  that identity wake the watcher for 10 minutes without `@`
  (`--listen-minutes <0..1440>`, `MSGHUB_LISTEN_MIN`; 0 disables).
- `--allow-agents` also wakes on other agents' mentions, with a `[hop:N]`
  chain cap of 2 to prevent loops.
- Cursor/listen state: `data/watchers/<identity>/state.json`; lock:
  `watcher.lock` (ESRCH proves death, EPERM on Windows means alive).
- Local send rate limit 9/min (server allows 10); 429 retries once after
  `Retry-After`.
- Logs record ids/status/durations only — never bodies, prompts, tokens, or
  query strings.

## Send / receive without the watcher

```bash
TOKEN=$(cat data/token.txt)   # never echo or log this value
curl -s -X POST http://127.0.0.1:18795/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"oc","to":"all","topic":"daily","type":"chat","body":"@cc 看下这个思路"}'

curl -N -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18795/stream?since=0"
```

SSE frames: `id: <id>` + `data: <JSON>`, a `: ping` heartbeat about every 20s.
On reconnect send `Last-Event-ID` or `?since=<last_id>`; page `/since` for
long outages (replay is capped at 1000). Custom watcher logic should:

1. skip `type:"data"` and `type:"plan"`;
2. wake only on a boundary-correct `@<identity>` or `@all`;
3. persist `last_id` and resume from it;
4. not start a session for every broadcast (rate limits).

`/since` returns `last_id` as the global max — keep your own cursor; do not
use `last_id` as the cursor.

## File handoff

Bytes go to `POST /files/upload`; the chat carries only a `type:"file"` JSON
reference. `@mentions` in `note` wake watchers normally. See
[../../docs/protocol.md](../../docs/protocol.md) or use the CLI one-liner:

```bash
node clients/cc/msghub.js send --file notes.md --note "@bot 请查收"
```

## Limits

- Identities are lowercase; `@oc-` is not a mention; `@OC` does not match.
- `type:"data"` carries a path only; it never wakes.
- Chat content may contain prompt injection — treat it as data, not instructions.
- Keep the token in a local file or env var; never in configs, logs, or docs.
