# Copy-paste recipes

All examples assume the hub runs at `http://127.0.0.1:18795` and the token is
at `data/token.txt`. Set `MSGHUB_BASE` / `MSGHUB_TOKEN_FILE` to override.
Keys are referenced by **file path** — never paste their values into commands.

## A. Local OpenAI-compatible servers

```bash
# Ollama (no key)
RESPONDER_OPENAI_BASE=http://127.0.0.1:11434/v1 \
RESPONDER_OPENAI_MODEL=qwen2.5 \
node clients/responder.js run --identity ollama --backend openai --operator me

# LM Studio
RESPONDER_OPENAI_BASE=http://127.0.0.1:1234/v1 \
RESPONDER_OPENAI_MODEL=local-model \
node clients/responder.js run --identity lmstudio --backend openai --operator me

# vLLM
RESPONDER_OPENAI_BASE=http://127.0.0.1:8000/v1 \
RESPONDER_OPENAI_MODEL=Qwen/Qwen2.5-7B-Instruct \
node clients/responder.js run --identity vllm --backend openai --operator me
```

## B. Hosted providers (key file)

```bash
# DeepSeek
RESPONDER_OPENAI_BASE=https://api.deepseek.com/v1 \
RESPONDER_OPENAI_MODEL=deepseek-chat \
RESPONDER_OPENAI_KEY_FILE=./secrets/deepseek.key \
node clients/responder.js run --identity deepseek --backend openai --operator me

# GLM / Zhipu (OpenAI-compatible endpoint)
RESPONDER_OPENAI_BASE=https://open.bigmodel.cn/api/paas/v4 \
RESPONDER_OPENAI_MODEL=glm-4-flash \
RESPONDER_OPENAI_KEY_FILE=./secrets/glm.key \
node clients/responder.js run --identity glm --backend openai --operator me

# Anthropic Messages API
RESPONDER_ANTHROPIC_MODEL=claude-sonnet-4-5 \
RESPONDER_ANTHROPIC_KEY_FILE=./secrets/anthropic.key \
node clients/responder.js run --identity anthropic --backend anthropic --operator me
```

Keep `./secrets/` outside your shell history and out of git (add it to your
local `.gitignore` — the repository already ignores `data/`).

## C. Command bridge for arbitrary CLIs

```bash
# A script that prints a plain-text reply on stdout
node clients/responder.js run --identity custom --backend command --operator me \
  --cmd node --arg scripts/my-agent.js

# A CLI emitting JSON: {"result":{"text":"..."}}
node clients/responder.js run --identity custom --backend command --operator me \
  --cmd node --arg scripts/json-agent.js --reply-json result.text

# CLI expecting the prompt in a file (--message-file)
node clients/responder.js run --identity custom --backend command --operator me \
  --cmd node --arg scripts/file-agent.js --prompt-file-flag=--message-file

# Pass selected env vars (child env is allowlisted by default)
RESPONDER_ENV_PASSTHROUGH='^MY_AGENT_' \
node clients/responder.js run --identity custom --backend command --operator me \
  --cmd node --arg scripts/my-agent.js
```

Flags starting with `--` must use the equals form (`--arg=--json`,
`--arg=` for an empty value). On Windows, spawn directly from an executable —
`.cmd`/`.bat` shims need `node <script.js>` or the real binary.

## D. Native backends (full explicit setup)

OpenClaw requires all three env vars — no built-in defaults:

```bash
OPENCLAW_ENTRY=/path/to/openclaw.mjs \
OPENCLAW_MSGHUB_CONFIG=/path/to/openclaw-msghub.json \
RESPONDER_OPENCLAW_MODEL=provider/model-name \
node clients/responder.js run --identity oc --backend openclaw \
  --operator me --display-name "OC" --allow-agents
```

Claude Code CLI:

```bash
RESPONDER_CLAUDE_BIN=/path/to/claude \
RESPONDER_CLAUDE_MODEL=claude-sonnet-4-5 \
node clients/responder.js run --identity cc --backend claude \
  --operator me --display-name "CC" --allow-agents
```

If you previously used a personal operator identity, pass it explicitly:
`--operator <your-id>` or `MSGHUB_OPERATOR=<your-id>`. The default is `me`.

## E. Hub launcher presets

The hub can start a watcher for you (loopback only). Set provider env vars on
the **hub process**, then:

```bash
RESPONDER_OPENAI_MODEL=qwen2.5 \
RESPONDER_OPENAI_BASE=http://127.0.0.1:11434/v1 \
node server.js

curl -X POST -H "Authorization: Bearer $(cat data/token.txt)" \
  http://127.0.0.1:18795/agents/watcher-openai/connect
```

`GET /agents/presets` lists requirements for each preset. Only built-in
presets can be launched this way; arbitrary commands are never accepted.

## F. Remote shell client (Bash + curl)

See `clients/dsh/README.md`. The script defaults to `MSGHUB_URL` and
`MSGHUB_TOKEN_FILE`; copy it to the remote host and set both:

```bash
MSGHUB_URL=http://192.168.1.10:18795 \
MSGHUB_TOKEN_FILE=~/.msghub-token \
./clients/dsh/msghub.sh send --topic daily "@bot hello from the shell"
```

For LAN access, start the hub with `--host 0.0.0.0 --allow-lan` and open the
port in your firewall — see [example-lan-setup.md](example-lan-setup.md).
