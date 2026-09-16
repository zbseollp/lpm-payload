#!/usr/bin/env bash
# Resolve Cloudflare Account ID + API token for wrangler deploy (GitHub Actions).
#
# Order (public-repo safe):
#   1. Payload GET /api/ci/cloudflare-credentials?tenant=<slug>
#      (per-tenant or Default credential — preferred)
#   2. Optional step-scoped CLOUDFLARE_* secrets (legacy shared account only)
#
# Never log full tokens. Reject values that would break / poison GITHUB_ENV.
set -euo pipefail

TENANT="${TENANT:-}"

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
    # Delimiter form avoids newline / special-char injection into subsequent steps.
    local delim
    delim="EOF_CF_$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')_$$"
    {
      printf '%s<<%s\n' "$key" "$delim"
      printf '%s\n' "$value"
      printf '%s\n' "$delim"
    } >> "$GITHUB_ENV"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

mask_secret() {
  local value="$1"
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$value" ]; then
    echo "::add-mask::${value}"
  fi
}

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
SOURCE="env"
LABEL=""
SUBDOMAIN="${CLOUDFLARE_WORKERS_DEV_SUBDOMAIN:-}"

if [ -z "$TENANT" ]; then
  echo "::error::TENANT not set — cannot resolve Cloudflare credentials."
  exit 1
fi

if [ -n "${PAYLOAD_URL:-}" ] && [ -n "${DEPLOY_REPORT_TOKEN:-}" ]; then
  BASE="${PAYLOAD_URL%/}"
  # Fail closed on non-2xx; empty body treated as miss (then optional env fallback).
  RESP="$(curl -sfS --max-time 30 \
    -H "x-deploy-report-token: ${DEPLOY_REPORT_TOKEN}" \
    -H "Accept: application/json" \
    "${BASE}/api/ci/cloudflare-credentials?tenant=${TENANT}" 2>/dev/null || true)"
  if [ -n "$RESP" ]; then
    P_ACCOUNT="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.ok&&j.accountId)process.stdout.write(String(j.accountId))}catch{}})")"
    P_TOKEN="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.ok&&j.apiToken)process.stdout.write(String(j.apiToken))}catch{}})")"
    P_SOURCE="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.ok&&j.source)process.stdout.write(String(j.source))}catch{}})")"
    P_LABEL="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.ok&&j.label)process.stdout.write(String(j.label))}catch{}})")"
    P_SUB="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);if(j.ok&&j.workersDevSubdomain)process.stdout.write(String(j.workersDevSubdomain))}catch{}})")"
    if [ -n "$P_ACCOUNT" ] && [ -n "$P_TOKEN" ]; then
      ACCOUNT_ID="$P_ACCOUNT"
      API_TOKEN="$P_TOKEN"
      SOURCE="${P_SOURCE:-payload-api}"
      LABEL="$P_LABEL"
      if [ -n "$P_SUB" ]; then SUBDOMAIN="$P_SUB"; fi
    fi
  fi
fi

if [ -z "$ACCOUNT_ID" ] || [ -z "$API_TOKEN" ]; then
  echo "::error::No Cloudflare credentials for tenant ${TENANT}."
  echo "::error::Link a credential (or Default) under Platform → Cloudflare credentials in Payload."
  echo "::error::Optional: set repo secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID as shared fallback only."
  exit 1
fi

mask_secret "$API_TOKEN"
mask_secret "$DEPLOY_REPORT_TOKEN"
set_github_env "CLOUDFLARE_ACCOUNT_ID" "$ACCOUNT_ID"
set_github_env "CLOUDFLARE_API_TOKEN" "$API_TOKEN"
set_github_env "CLOUDFLARE_CREDENTIAL_SOURCE" "$SOURCE"
if [ -n "$SUBDOMAIN" ]; then
  set_github_env "CLOUDFLARE_WORKERS_DEV_SUBDOMAIN" "$SUBDOMAIN"
fi

echo "Cloudflare credentials resolved (source=${SOURCE}, account=${ACCOUNT_ID:0:8}…, label=${LABEL:-n/a}, tenant=${TENANT})"
