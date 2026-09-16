#!/usr/bin/env bash
# Resolve GitHub token for checking out an external client repo (GitHub Actions).
# Order: Payload /api/ci/github-token → EXTERNAL_REPO_GITHUB_TOKEN → github.token
#
# Public-repo safe: mask token, reject newlines, delimiter GITHUB_ENV writes.
set -euo pipefail

TENANT="${TENANT:-}"
TOKEN=""

reject_unsafe_secret() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "::error::${name} contains a newline — refusing to write GITHUB_ENV (injection risk)."
    exit 1
  fi
}

set_github_env() {
  local key="$1"
  local value="$2"
  reject_unsafe_secret "$key" "$value"
  if [ -n "${GITHUB_ENV:-}" ]; then
    local delim
    delim="EOF_GH_$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')_$$"
    {
      printf '%s<<%s\n' "$key" "$delim"
      printf '%s\n' "$value"
      printf '%s\n' "$delim"
    } >> "$GITHUB_ENV"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

if [ -n "${PAYLOAD_URL:-}" ] && [ -n "${DEPLOY_REPORT_TOKEN:-}" ] && [ -n "$TENANT" ]; then
  BASE="${PAYLOAD_URL%/}"
  RESP="$(curl -sfS --max-time 30 \
    -H "x-deploy-report-token: ${DEPLOY_REPORT_TOKEN}" \
    -H "Accept: application/json" \
    "${BASE}/api/ci/github-token?tenant=${TENANT}" 2>/dev/null || true)"
  if [ -n "$RESP" ]; then
    TOKEN="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(j.token&&j.ok?String(j.token):'')}catch{}})")"
  fi
fi

if [ -z "$TOKEN" ] && [ -n "${GH_FALLBACK_TOKEN:-}" ]; then
  TOKEN="$GH_FALLBACK_TOKEN"
fi

if [ -z "$TOKEN" ]; then
  set_github_env "CLIENT_GITHUB_TOKEN" ""
  echo "::warning::No client GitHub token resolved; checkout may fail for private external repos."
  exit 0
fi

# Workflow commands must go to step stdout — never append these to GITHUB_ENV.
echo "::add-mask::${TOKEN}"
set_github_env "CLIENT_GITHUB_TOKEN" "$TOKEN"
