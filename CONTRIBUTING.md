# Contributing

## Ground rules

1. **Zero npm dependencies.** Node 24 built-ins only. No package manager lockfiles.
2. **JSONL is the single source of truth.** No `state.json`-style shadow state;
   derived caches are fine, but they must be reconstructible from JSONL.
3. **Writes before broadcasts.** The send path must `write` + `fsync` before
   SSE broadcast; `writeAllSync` must handle partial writes.
4. **Protocol changes are test-first.** Change/add tests in `test/` before the
   implementation. `IDENTITY_RE`, topic validation, and message types stay in
   one shared source (`lib/protocol.js`) — don't fork the regex into a client.
5. **Secrets never enter the repository.** Tokens/keys are referenced by env
   var names or file *paths* only — never values. Access logs record paths,
   never query strings. `test/hygiene.test.js` enforces this.
6. **Small changes.** One bug, one fix. Preserve existing behavior of the
   `openclaw` and `claude` backends; `test/backends.test.js` guards prompt
   byte-equivalence and error-string formats.

## Development

```bash
node --test test/*.test.js        # full suite
node bench/ui-bench.js --check    # UI perf invariants (needs local Chrome)
node scripts/doctor.mjs           # runtime self-check
```

Node 24+ required (`fetch`, `AbortController`, `node:test` all built in).
`data/` is gitignored; generate a fresh token with `node scripts/setup.mjs`.

## Adding a backend

Backends live in `clients/backends.js`. Implement the interface described at
the top of that file (`resolveConfig`, `preflight`, `buildTurn`,
`extractReply`), add it to `BACKENDS`, and inject all I/O (`fetchImpl` /
`spawnImpl`) so tests never touch real providers. Turn failures must reject —
never fabricate a reply. Keep child env allowlisted; resolve keys at turn
time; truncate provider error bodies to one line before they can reach logs.

## Pull requests

- Describe the behavior change and how you verified it (commands + output).
- Keep the test suite green on Windows and Linux (see CI matrix).
- Don't commit `data/`, `config.local.*`, `.claude/settings.json`, screenshots,
  or benchmark snapshots.
