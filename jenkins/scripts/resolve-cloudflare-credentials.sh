#!/usr/bin/env bash
# Resolve Cloudflare Account ID + API token for wrangler deploy.
# Order: Payload /api/ci/cloudflare-credentials → existing CLOUDFLARE_* env (legacy).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  if [ -f "$SCRIPT_DIR/setup-node-pnpm.sh" ]; then
    bash "$SCRIPT_DIR/setup-node-pnpm.sh"
    # shellcheck source=load-node-pnpm.sh
    source "$SCRIPT_DIR/load-node-pnpm.sh"
  fi
fi

TENANT="${TENANT:-${tenant_slug:-}}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
SOURCE="env"
LABEL=""
SUBDOMAIN="${CLOUDFLARE_WORKERS_DEV_SUBDOMAIN:-}"

if [ -n "${PAYLOAD_URL:-}" ] && [ -n "${DEPLOY_REPORT_TOKEN:-}" ] && [ -n "$TENANT" ]; then
  BASE="${PAYLOAD_URL%/}"
  RESP="$(curl -sS -H "x-deploy-report-token: ${DEPLOY_REPORT_TOKEN}" \
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
  echo "ERROR: No Cloudflare credentials for tenant ${TENANT:-<unset>}." >&2
  echo "       Link a credential / Default in Payload, or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID." >&2
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$API_TOKEN"
export CLOUDFLARE_CREDENTIAL_SOURCE="$SOURCE"
if [ -n "$SUBDOMAIN" ]; then
  export CLOUDFLARE_WORKERS_DEV_SUBDOMAIN="$SUBDOMAIN"
fi

echo "Cloudflare credentials resolved (source=${SOURCE}, account=${ACCOUNT_ID:0:8}…, label=${LABEL:-n/a}, tenant=${TENANT:-<unset>})"
