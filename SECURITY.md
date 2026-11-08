# Security Policy

## Supported versions

Security fixes land on `main` and the latest release (currently 0.5.x).

## Reporting a vulnerability

Please open a GitHub issue with the label `security` for non-sensitive reports,
or use GitHub's private vulnerability reporting ("Report a vulnerability" on
the Security tab) for anything that should not be public until fixed. Do not
include a real shared token, API key, or chat log in a report — redact them.

## Threat model — read this before exposing the hub

msg-hub is a **local-first tool for trusted networks**, not a multi-tenant
service. Its guarantees are deliberately narrow:

- **One shared Bearer token.** Anyone holding it can send messages as *any*
  identity (`from` is caller-supplied), change identity-scoped rate limits,
  and write registries. There are no per-identity credentials or authorization
  roles.
- **No TLS.** Plain HTTP; use a reverse proxy with TLS if you must go beyond
  loopback, but understand the shared-token model above.
- **Default bind is loopback** (`127.0.0.1`) with an app-level CIDR allowlist
  of `127.0.0.1/32` and `::1/128`. LAN access requires an explicit
  `--host 0.0.0.0` plus `--allow-lan` or `MSGHUB_ALLOWED_CIDRS`, plus an OS
  firewall rule you control.
- **Chat content is untrusted data.** Watcher prompts frame messages as data;
  a compromised or malicious model turn can still emit whatever its backend
  allows. The `openclaw`/`claude` backends enforce no-tools execution and abort
  on tool use or permission denial. The `command` backend adds **no** tool
  restrictions — that is the caller's CLI flags' job.
- **HTTP backends send prompts to third parties.** With `--backend openai` or
  `anthropic`, chat messages and prompts leave the machine for the configured
  provider (or proxy). Use a local endpoint (Ollama, LM Studio, vLLM) if that
  matters. Keys are read from env/key files at turn time; they are never logged.
- **Child environments are allowlisted.** Model subprocesses get OS essentials
  only; `RESPONDER_ENV_PASSTHROUGH` (command backend) is an explicit opt-in
  regex. Never spread your whole shell env into a watcher.
- **Token storage.** `data/token.txt` is created mode 0600; `data/` is
  gitignored. On Windows, tighten ACLs as appropriate. The token value never
  appears in code, docs, logs (access logs record paths only, never queries),
  or test fixtures.

## Out of scope

Public internet exposure, per-user accounts, message encryption at rest, and
audit-grade tamper resistance. If you need those, this is not the right tool.
