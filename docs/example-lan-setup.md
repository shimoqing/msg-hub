# Example: LAN setup (two machines)

The default configuration is loopback-only on purpose. This example shows a
host running the hub at `192.168.1.10` and a client machine at
`192.168.1.20`. Replace these addresses with your own.

## 1. Hub host

```bash
node scripts/setup.mjs
node server.js --host 0.0.0.0 --allow-lan
```

`--allow-lan` adds `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` to the
app-level CIDR allowlist. For a narrower scope, set an explicit list instead:

```bash
MSGHUB_ALLOWED_CIDRS='127.0.0.1/32,::1/128,192.168.1.20/32' \
node server.js --host 0.0.0.0
```

Open TCP 18795 in the OS firewall for the client subnet only. On Windows,
`scripts/install-service.ps1 -NodePath <path-to-node> -RemoteCidr
192.168.1.0/24` creates a scoped inbound rule (requires Administrator); review
`-WhatIf` first. On Linux, use ufw/nftables analogously, e.g.:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 18795 proto tcp
```

## 2. Client machine

Copy the token file over a trusted channel (or paste its value into the token
prompt) — never commit it:

```bash
scp hub-host:path/to/msg-hub/data/token.txt ~/.msghub-token
chmod 600 ~/.msghub-token

MSGHUB_URL=http://192.168.1.10:18795 \
MSGHUB_TOKEN_FILE=~/.msghub-token \
./clients/dsh/msghub.sh health
```

Open `http://192.168.1.10:18795/` in a browser; because the request is not
loopback, the UI asks for the token once (it is stored in that browser's
localStorage). A watcher on the client machine uses `MSGHUB_BASE` in the same
way.

## 3. Verify

```bash
curl -s http://192.168.1.10:18795/health           # no auth needed
node scripts/doctor.mjs                            # path/status overview
```

`403 forbidden_ip` means the client is outside `MSGHUB_ALLOWED_CIDRS` (or the
OS firewall blocked the connection). `401 unauthorized` means the token is
wrong or stale. Access logs record paths only — they will not show the token.

## Notes

- No TLS: use only on a network you trust. For anything beyond that, put a
  TLS-terminating reverse proxy in front — but remember the shared-token model
  (any holder can send as any identity); see [../SECURITY.md](../SECURITY.md).
- `data/` is gitignored: chat logs and the token never travel with the repo.
- `--host 0.0.0.0` without `--allow-lan` (or an explicit CIDR list) still
  denies non-loopback clients at the app layer.
