#!/usr/bin/env bash
set -euo pipefail

URL="${MSGHUB_URL:-http://127.0.0.1:18795}"
TOKEN_FILE="${MSGHUB_TOKEN_FILE:-$HOME/.msghub-token}"
IDENTITY="${MSGHUB_IDENTITY:-dsh}"
TOPIC="${MSGHUB_TOPIC:-daily}"

usage() {
  cat <<'EOF'
usage: msghub <command> [options]
  health
  send [--topic T] [--to all] [--type chat] [--body TEXT] [TEXT...]
  since <id> [--topic T] [--limit N]
  stream [--topic T] [--since ID]
env: MSGHUB_URL, MSGHUB_TOKEN, MSGHUB_TOKEN_FILE, MSGHUB_IDENTITY
EOF
}

need_token() {
  if [[ -n "${MSGHUB_TOKEN:-}" ]]; then
    TOKEN="$MSGHUB_TOKEN"
  elif [[ -r "$TOKEN_FILE" ]]; then
    TOKEN="$(<"$TOKEN_FILE")"
  else
    echo "token not found: set MSGHUB_TOKEN or create $TOKEN_FILE (mode 600)" >&2
    exit 1
  fi
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  printf '%s' "$s"
}

command="${1:-help}"
shift || true

case "$command" in
  health)
    curl -fsS "$URL/health"
    printf '\n'
    ;;
  send)
    TO="all"
    TYPE="chat"
    BODY=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --topic) TOPIC="$2"; shift 2 ;;
        --to) TO="$2"; shift 2 ;;
        --type) TYPE="$2"; shift 2 ;;
        --body) BODY="$2"; shift 2 ;;
        *) BODY="${BODY:+$BODY }$1"; shift ;;
      esac
    done
    [[ -n "$BODY" ]] || { echo "message body is required" >&2; exit 1; }
    need_token
    payload="$(printf '{"from":"%s","to":"%s","topic":"%s","type":"%s","body":"%s"}' \
      "$IDENTITY" "$TO" "$TOPIC" "$TYPE" "$(json_escape "$BODY")")"
    curl -fsS -X POST "$URL/send" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$payload"
    printf '\n'
    ;;
  since)
    ID="${1:?usage: msghub since <id>}"; shift
    LIMIT=200
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --topic) TOPIC="$2"; shift 2 ;;
        --limit) LIMIT="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
      esac
    done
    need_token
    curl -fsS -H "Authorization: Bearer $TOKEN" \
      "$URL/since/$ID?topic=$TOPIC&limit=$LIMIT"
    printf '\n'
    ;;
  stream)
    SINCE=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --topic) TOPIC="$2"; shift 2 ;;
        --since) SINCE="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
      esac
    done
    need_token
    exec curl -fsSN -H "Authorization: Bearer $TOKEN" \
      "$URL/stream?topic=$TOPIC&since=$SINCE&identity=dsh"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "unknown command: $command" >&2
    usage >&2
    exit 1
    ;;
esac
