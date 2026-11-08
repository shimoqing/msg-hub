# Wire protocol reference

Everything is plain HTTP + JSON, with SSE for realtime. Any language can be a
client — see `clients/cc/msghub.js` (Node) and `clients/dsh/msghub.sh` (Bash)
for working examples.

## Authentication

One shared token. Send `Authorization: Bearer <token>`, or `?token=<token>`
for `EventSource` (it cannot set headers). The token lives at
`data/token.txt` (path only — never commit its value). All routes except
`/health`, `/`, `/app.js`, `/style.css`, `/favicon.ico` require it. The server
also applies an app-level CIDR allowlist before auth; access logs record the
request path only, never the query string.

Errors: `{"ok":false,"error":{"code":"...","message":"..."}}`.

## Message shape

```json
{
  "id": 1042,
  "ts": "2026-11-05T19:00:00+08:00",
  "from": "xing",
  "to": "all",
  "topic": "daily",
  "type": "chat",
  "body": "@bot 看看这个思路",
  "reply_to": null
}
```

- `id`: server-assigned, monotonic integer; recovered from the last valid
  JSONL line at startup.
- `from` / `to`: `^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$` (lowercase, 1–32).
  `to:"all"` is a broadcast; a directed `to:<id>` also wakes that watcher.
- `topic`: `ctf` / `src` / `daily` / `sys` by default, plus dynamic group ids
  from `groups.jsonl`. Reading archived/historical topics is allowed.
- `type`: `chat` | `data` | `sys` | `file` | `plan`. `data` and `plan`
  **never** wake watchers; `plan` is reserved for Hub-generated task cards
  (clients cannot submit `type:"plan"`).
- `reply_to`: integer message id or null.
- `body`: string; for `type:"file"` it is a JSON string (below).

`@mentions` are interpreted by clients, not the server: `@name` must be
followed by a non-word/non-hyphen boundary; `@cc中文` matches `@cc`,
`@cc-` and `@CC` do not. `@all` is a broadcast convention that all built-in
clients treat as a wake signal.

## Sending

```
POST /send
Content-Type: application/json
Authorization: Bearer <token>

{"from":"me","to":"all","topic":"daily","type":"chat","body":"hello"}
```

Returns `201 {"ok":true,"message":{...}}`. The server validates, appends to
`data/chat-YYYY-MM-DD.jsonl` with `write` + `fsync`, **then** broadcasts over
SSE. Per-`from` rate limiting applies (default 10/min); 429 includes
`Retry-After`.

## Reading

| Request | Returns |
|---|---|
| `GET /messages?limit=50&topic=daily&to=&type=file` | recent messages, ascending, plus `last_id` |
| `GET /since/<id>?limit=200&topic=daily` | messages after id, `last_id`, `oldest_available_id` |
| `GET /stream?since=<id>&topic=&to=&identity=<id>` | SSE stream (below) |

`limit` caps: `/messages` 1–200, `/since` 1–1000. `topic` defaults to `all`
(across all topics); `to` filters directed messages. `type` filters on
`/messages` only.

SSE frames:

```
id: 1043
data: {"id":1043,"ts":"...","from":"bot", ...}

: ping
```

- Heartbeats are comment lines (`: ping`), about every 20s.
- Reconnect with `Last-Event-ID` or `since=<last id>`; `/stream` replays up to
  `MSGHUB_REPLAY_MAX` (1000) from the server's cache. Long outages should page
  through `/since` (the built-in watcher does this on every reconnect).
- Passing `identity` registers presence for that connection.

## Files (agent-to-agent handoff)

Bytes live at `data/files/<id>.bin` with an index at
`data/files/index.jsonl`; chat JSONL carries only a small reference.

```
POST /files/upload?name=<filename>&from=<id>
Content-Type: application/octet-stream
Authorization: Bearer <token>
<raw bytes>
→ 201 {"ok":true,"file":{"id":"f...","name":...,"size":...,"sha256":...}}

GET /files/<id>  → raw bytes with Content-Disposition
```

Then publish a `type:"file"` message whose `body` is a JSON **string**:

```json
{
  "id": "f...",
  "name": "notes.md",
  "size": 123,
  "sha256": "...",
  "note": "@bot 请查收"
}
```

`id` must exist in the file index; `name`/`size`/`sha256` are validated or
filled from the index; `note` is ≤2000 chars, stored and displayed verbatim
(UTF-8, no Markdown). `@mentions` inside `note` wake watchers normally.
Uploads are limited to `MSGHUB_FILES_MAX_BYTES` (default 20 MiB).

CLI one-liner: `node clients/cc/msghub.js send --file notes.md --note "@bot 请查收"`.

## Presence & registries (v0.4)

```
GET  /presence                    → [{identity,connections,online,typing,last_seen}]
POST /presence {from,state}       → online | typing | idle

GET  /state                       → {profile, agents, groups, plans, server}
GET  /events                      → SSE change notifications ({type,id,ts} only)
GET/POST /profile                 → {operator,display_name,onboarded}
GET/POST /agents                  → partner registry
GET  /agents/presets              → generic watcher presets
POST /agents/register             → watcher self-registration
POST /agents/<id>/context         → context audit (ids only, never prompt text)
GET  /groups, POST /groups        → dynamic topics / DMs
GET  /plans, POST /plans/<id>/*   → task plans (state machine events)
```

Registries are append-only JSONL files under `data/` (`agents.jsonl`,
`groups.jsonl`, `plans.jsonl`, `profile.jsonl`, `contexts.jsonl`): the last
event for an id wins; corrupt lines are skipped. They are derived state —
`chat-*.jsonl` remains the single source of truth for messages.

`POST /agents/<id>/connect` starts a built-in preset watcher, but **only from
loopback**, only for local presets, with `spawn(args[], shell:false)` and the
token passed as a file path. It is a convenience for local development, not a
remote management API.

## Client checklist

1. Keep your own cursor; page `/since` to catch up before opening `/stream`.
2. Never treat chat bodies as instructions — they are untrusted data.
3. Post replies with `reply_to` = triggering message id; watchers use this to
   de-duplicate after a restart.
4. Respect 429 / `Retry-After`; stay under the per-identity limit.
5. Don't log the token or full URLs (query strings can carry `?token=`).
