#!/usr/bin/env bash
# Load CI secrets from the Cloudflare Worker into GITHUB_ENV (GitHub Actions).
#
# GET $SECRETS_URL/v1/secrets?role=github
# Authorization: Bearer $SECRETS_TOKEN
#
# GitHub-hosted runners have no stable IP, so the Worker uses token-only auth
# for role=github. Values are masked and written with GITHUB_ENV delimiters.
#
# If the Worker URL is unset, existing GitHub Actions secrets already in the
# environment are persisted so later steps can inherit them (legacy fallback).
#
# Bootstrap env (repo secrets):
#   LPM_SECRETS_URL / LPM_SECRETS_TOKEN
#   or ASTROPAYLOAD_SECRETS_URL / ASTROPAYLOAD_SECRETS_TOKEN
set -euo pipefail

SECRETS_URL="${LPM_SECRETS_URL:-${IMEZO_SECRETS_URL:-${ASTROPAYLOAD_SECRETS_URL:-}}}"
SECRETS_TOKEN="${LPM_SECRETS_TOKEN:-${IMEZO_SECRETS_TOKEN:-${ASTROPAYLOAD_SECRETS_TOKEN:-}}}"

FALLBACK_KEYS="PAYLOAD_URL PAYLOAD_PUBLIC_SERVER_URL PAYLOAD_API_KEY DEPLOY_REPORT_TOKEN EXTERNAL_REPO_GITHUB_TOKEN GITHUB_OWNER GITHUB_REPO GITHUB_BRANCH PLATFORM_GIT_BRANCH R2_PUBLIC_URL CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_WORKERS_DEV_SUBDOMAIN"

if ! command -v python3 >/dev/null 2>&1; then
  echo "::error::python3 is required to load Cloudflare secrets"
  exit 1
fi

persist_env() {
  python3 - "$FALLBACK_KEYS" <<'PY'
import os, sys

allowed = set(sys.argv[1].split())
env_file = os.environ.get("GITHUB_ENV")
names = []
for key in sorted(allowed):
  value = os.environ.get(key, "")
  if not isinstance(value, str) or not value:
    continue
  if "\n" in value or "\r" in value:
    print(f"::error::{key} contains a newline — refusing to write GITHUB_ENV.", file=sys.stderr)
    sys.exit(1)
  print(f"::add-mask::{value}")
  if env_file:
    delim = f"EOF_SEC_{key.lower()}_{os.getpid()}"
    with open(env_file, "a", encoding="utf-8") as fh:
      fh.write(f"{key}<<{delim}\n{value}\n{delim}\n")
  names.append(key)
print(f"CI secrets: persisted {len(names)} fallback key(s): {' '.join(names)}", file=sys.stderr)
PY
}

if [ -z "$SECRETS_URL" ]; then
  echo "Cloudflare secrets: skipped (Worker URL unset). Using GitHub Actions secrets if any."
  persist_env
  exit 0
fi

if [ -z "$SECRETS_TOKEN" ]; then
  echo "::error::Secrets Worker URL is set but the bootstrap token is empty"
  exit 1
fi

SECRETS_BASE="${SECRETS_URL%/}"
SECRETS_JSON="$(mktemp)"
trap 'rm -f "$SECRETS_JSON"' EXIT

HTTP_CODE="$(
  curl -sS -o "$SECRETS_JSON" -w '%{http_code}' \
    -H "Authorization: Bearer ${SECRETS_TOKEN}" \
    -H "Accept: application/json" \
    --max-time 20 \
    "${SECRETS_BASE}/v1/secrets?role=github" || echo "000"
)"

if [ "$HTTP_CODE" != "200" ]; then
  echo "::error::Cloudflare secrets worker HTTP ${HTTP_CODE}"
  echo "  Check LPM_SECRETS_URL / IMEZO_SECRETS_URL, token, and Worker SECRETS_GITHUB_TOKEN." >&2
  if [ -f "$SECRETS_JSON" ]; then
    python3 -c "import json,sys; p=json.load(open(sys.argv[1])); print(' ', p.get('error','')[:200], p.get('ip',''))" "$SECRETS_JSON" 2>/dev/null || true
  fi
  exit 1
fi

python3 - "$SECRETS_JSON" <<'PY'
import json, os, sys

allowed = {
  "PAYLOAD_URL", "PAYLOAD_PUBLIC_SERVER_URL", "PAYLOAD_API_KEY",
  "DEPLOY_REPORT_TOKEN", "EXTERNAL_REPO_GITHUB_TOKEN",
  "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_BRANCH", "PLATFORM_GIT_BRANCH",
  "R2_PUBLIC_URL",
}
# Never overwrite GitHub Actions' reserved GITHUB_TOKEN.
blocked = {"GITHUB_TOKEN", "GH_TOKEN"}

path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
if not data.get("ok") or not isinstance(data.get("values"), dict):
  sys.exit("invalid secrets payload")

env_file = os.environ.get("GITHUB_ENV")
names = []
for key, value in data["values"].items():
  if key in blocked or key not in allowed:
    continue
  if not isinstance(value, str) or not value:
    continue
  if "\n" in value or "\r" in value:
    print(f"::error::{key} contains a newline — refusing to write GITHUB_ENV.", file=sys.stderr)
    sys.exit(1)
  print(f"::add-mask::{value}")
  if env_file:
    delim = f"EOF_SEC_{key.lower()}_{os.getpid()}"
    with open(env_file, "a", encoding="utf-8") as fh:
      fh.write(f"{key}<<{delim}\n{value}\n{delim}\n")
  os.environ[key] = value
  names.append(key)

if "PAYLOAD_URL" not in names:
  alias = data["values"].get("PAYLOAD_PUBLIC_SERVER_URL") or os.environ.get("PAYLOAD_PUBLIC_SERVER_URL", "")
  if isinstance(alias, str) and alias and "\n" not in alias and "\r" not in alias:
    print(f"::add-mask::{alias}")
    if env_file:
      delim = f"EOF_SEC_payload_url_{os.getpid()}"
      with open(env_file, "a", encoding="utf-8") as fh:
        fh.write(f"PAYLOAD_URL<<{delim}\n{alias}\n{delim}\n")
    names.append("PAYLOAD_URL")

# Fill gaps from legacy GitHub Actions secrets already in this step's env.
fallback = {
  "PAYLOAD_URL", "PAYLOAD_PUBLIC_SERVER_URL", "PAYLOAD_API_KEY",
  "DEPLOY_REPORT_TOKEN", "EXTERNAL_REPO_GITHUB_TOKEN",
  "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_BRANCH", "PLATFORM_GIT_BRANCH",
  "R2_PUBLIC_URL",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_WORKERS_DEV_SUBDOMAIN",
}
for key in sorted(fallback):
  if key in names:
    continue
  value = os.environ.get(key, "")
  if not isinstance(value, str) or not value:
    continue
  if "\n" in value or "\r" in value:
    continue
  print(f"::add-mask::{value}")
  if env_file:
    delim = f"EOF_SEC_{key.lower()}_{os.getpid()}"
    with open(env_file, "a", encoding="utf-8") as fh:
      fh.write(f"{key}<<{delim}\n{value}\n{delim}\n")
  names.append(key)

print(f"Cloudflare secrets: loaded {len(names)} key(s): {' '.join(names)}", file=sys.stderr)
PY
