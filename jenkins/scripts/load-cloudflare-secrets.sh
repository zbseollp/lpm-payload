#!/usr/bin/env bash
# Load Jenkins role secrets from the Cloudflare Worker (lpm-payload-secrets).
# Must be sourced so exports remain in the job shell:
#   # shellcheck source=load-cloudflare-secrets.sh
#   source "$SCRIPT_DIR/load-cloudflare-secrets.sh"
#
# Requires Jenkins global env:
#   LPM_SECRETS_URL (or ASTROPAYLOAD_SECRETS_URL)
#   LPM_SECRETS_TOKEN (or ASTROPAYLOAD_SECRETS_TOKEN)
# If URL is unset, this is a no-op (legacy Jenkins credentials still work).

SECRETS_URL="${LPM_SECRETS_URL:-${ASTROPAYLOAD_SECRETS_URL:-}}"
SECRETS_TOKEN="${LPM_SECRETS_TOKEN:-${ASTROPAYLOAD_SECRETS_TOKEN:-}}"

if [ -z "$SECRETS_URL" ]; then
  echo "Cloudflare secrets: skipped (LPM_SECRETS_URL unset). Using Jenkins-bound credentials if any."
  return 0 2>/dev/null || true
fi

if [ -z "$SECRETS_TOKEN" ]; then
  echo "ERROR: LPM_SECRETS_URL is set but LPM_SECRETS_TOKEN is empty" >&2
  return 1 2>/dev/null || exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to load Cloudflare secrets" >&2
  return 1 2>/dev/null || exit 1
fi

SECRETS_BASE="${SECRETS_URL%/}"
SECRETS_JSON="$(mktemp)"
trap 'rm -f "$SECRETS_JSON"' RETURN

HTTP_CODE="$(
  curl -sS -o "$SECRETS_JSON" -w '%{http_code}' \
    -H "Authorization: Bearer ${SECRETS_TOKEN}" \
    -H "Accept: application/json" \
    --max-time 20 \
    "${SECRETS_BASE}/v1/secrets?role=jenkins" || echo "000"
)"

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Cloudflare secrets worker HTTP ${HTTP_CODE}" >&2
  echo "  Check LPM_SECRETS_URL, token, and Worker ALLOWED_IPS (Jenkins public IP)." >&2
  if [ -f "$SECRETS_JSON" ]; then
    python3 -c "import json,sys; p=json.load(open(sys.argv[1])); print(' ', p.get('error','')[:200], p.get('ip',''))" "$SECRETS_JSON" 2>/dev/null || true
  fi
  return 1 2>/dev/null || exit 1
fi

LOADED="$(
  python3 - "$SECRETS_JSON" <<'PY'
import json, os, sys
allowed = {
  "PAYLOAD_URL", "PAYLOAD_API_KEY", "DEPLOY_REPORT_TOKEN",
  "EXTERNAL_REPO_GITHUB_TOKEN", "PLATFORM_GIT_TOKEN",
  "GITHUB_OWNER", "GITHUB_REPO", "PLATFORM_GIT_BRANCH",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_WORKERS_DEV_SUBDOMAIN",
  "R2_PUBLIC_URL", "PUBLIC_R2_URL", "PUBLIC_PAYLOAD_MEDIA_URL",
  "ALLOWED_GITHUB_ORGS", "CLIENT_REPO_SECURITY_SCAN",
  "SECURITY_ALERT_WEBHOOK_URL", "CLIENT_BUILD_ENV",
  "GH_TOKEN", "GITHUB_TOKEN",
}
path = sys.argv[1]
data = json.load(open(path))
if not data.get("ok") or not isinstance(data.get("values"), dict):
  sys.exit("invalid secrets payload")
names = []
for key, value in data["values"].items():
  if key not in allowed or not isinstance(value, str) or not value:
    continue
  os.environ[key] = value
  print(f"export {key}={json.dumps(value)}")
  names.append(key)
# Platform git token aliases used by some jobs
if "PLATFORM_GIT_TOKEN" in data["values"] and data["values"]["PLATFORM_GIT_TOKEN"]:
  tok = data["values"]["PLATFORM_GIT_TOKEN"]
  if "GH_TOKEN" not in names:
    print(f"export GH_TOKEN={json.dumps(tok)}")
    names.append("GH_TOKEN")
  if "GITHUB_TOKEN" not in names:
    print(f"export GITHUB_TOKEN={json.dumps(tok)}")
    names.append("GITHUB_TOKEN")
print(f"Cloudflare secrets: loaded {len(names)} key(s): {' '.join(names)}", file=sys.stderr)
PY
)"

eval "$LOADED"
