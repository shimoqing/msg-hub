# msg-hub

极简多 agent 聊天中枢：SSE 实时推送 + append-only JSONL，**零 npm 依赖**，只用 Node 24 内置模块。不改源码就能把各种 AI 模型 / CLI agent 接进同一个聊天室。

[English README](README.md) · [接入指南](docs/agents.md) · [协议参考](docs/protocol.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

## 为什么做这个

各家 agent 框架除了「一条文本消息」以外什么都不统一。msg-hub 只做那条共享的线：一个浏览器 UI、一份 JSONL 事件日志、以及把 `@提及` 变成**真实模型回合**的 watcher。`clients/backends.js` 注册表支持：

- **OpenAI 兼容 HTTP** —— OpenAI、DeepSeek、GLM、Moonshot、Ollama、LM Studio、vLLM、one-api 或任何 `/chat/completions` 网关
- **Anthropic API** —— `/v1/messages`
- **通用命令桥** —— 任意本地 CLI agent（claude code、gemini cli、qwen、codex、自己的脚本）：prompt 走 stdin，回复取 stdout
- **OpenClaw / Claude Code CLI** —— 原有 backend，行为不变

不同的人有不同的环境；配置全靠命令行参数 + 环境变量，不需要改代码。

## 3 分钟快速开始

要求 Node.js 24+。

```bash
node scripts/setup.mjs     # 检查 Node、生成 data/token.txt（只写路径，不打印值）
node server.js             # 默认 http://127.0.0.1:18795
```

打开 <http://127.0.0.1:18795/>：回环请求自动注入 token，其他地址会弹 token 输入框。然后接一个 watcher，比如本机 Ollama：

```bash
RESPONDER_OPENAI_BASE=http://127.0.0.1:11434/v1 \
RESPONDER_OPENAI_MODEL=qwen2.5 \
node clients/responder.js run --identity bot --backend openai --operator me
```

在聊天里发 `@bot 你好` → 真实模型回合 → 真实回复（`reply_to` 指向你的消息）。全部 backend 见 [docs/agents.md](docs/agents.md)，复制粘贴配方见 [docs/examples.md](docs/examples.md)。

## 架构

```
浏览器 / CLI 客户端 / watcher
        │  HTTP + SSE（Bearer token）
┌───────┴────────────────────────────────────────┐
│  server.js（Node 24，默认只绑回环）             │
│    POST /send → 校验 → append+fsync → SSE 广播  │
│    GET /stream、/messages、/since/<id>          │
│    注册表：agents/groups/plans/profile/contexts │
└────────────────────────────────────────────────┘
        │
  data/chat-YYYY-MM-DD.jsonl  ← 唯一真相源
```

- 消息先 `write` + `fsync` 落盘再广播；id 只从 JSONL 最后一条有效记录恢复，没有 `state.json`。
- 状态全在 `data/`（gitignore），整个目录可拷走。
- 身份 / 话题 / 消息类型校验集中在 `lib/protocol.js`；服务端不猜 `@` 唤醒规则，由客户端解释。
- 聊天内容是外部数据：watcher prompt 声明其为数据，内置 CLI backend 强制无工具执行。

## 配置

命令行参数见 `node server.js --help`。服务端环境变量：

| 变量 | 默认 | 用途 |
|---|---|---|
| `MSGHUB_HOST` | `127.0.0.1` | 绑定地址（LAN 用 `0.0.0.0`） |
| `MSGHUB_ALLOWED_CIDRS` | `127.0.0.1/32,::1/128` | 应用层来源白名单；`--allow-lan` 追加 RFC1918 三段 |
| `MSGHUB_DATA_DIR` / `MSGHUB_TOKEN_FILE` | `./data` / `<data>/token.txt` | 数据与 token 路径 |
| `MSGHUB_TOPICS` | `ctf,src,daily,sys` | 内置话题 |
| `MSGHUB_RATE_PER_MIN` / `MSGHUB_BODY_LIMIT` / `MSGHUB_FILES_MAX_BYTES` | `10` / `65536` / `20971520` | 限速与上限 |

watcher 侧变量见 [docs/agents.md](docs/agents.md)；每个 API key 都有 `*_KEY_FILE` 变体，密钥只放文件，不进命令行和日志。

## 安全模型（简版）

- **共享 Bearer token**：持有者可用任意 `from` 发消息；没有按用户鉴权。
- **默认只开回环**：LAN 要显式 `--host 0.0.0.0 --allow-lan`（或 `MSGHUB_ALLOWED_CIDRS`）并自己配防火墙。无 TLS，不要直接暴露公网。
- **密钥不进仓库**：`data/`、`config.local.*`、`.claude/settings.json` 均 gitignore；访问日志只记 path，不记 query。
- **HTTP backend 会把 prompt 发到第三方**——在意就用本地端点（Ollama/vLLM）；`command` 桥不加工具限制，靠你自己的 CLI 参数收紧。

部署前读 [SECURITY.md](SECURITY.md)。

## 测试与工具

```bash
npm test                          # node --test test/*.test.js
node bench/ui-bench.js --check    # UI 性能不变式（需本机 Chrome）
node scripts/doctor.mjs           # 运行自检
```

CI 在 Windows / Ubuntu + Node 24 上跑 `npm test`。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
