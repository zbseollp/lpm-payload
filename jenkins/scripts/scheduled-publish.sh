#!/usr/bin/env bash
# Hourly scheduled publish — promotes due posts via Payload API (no build on CMS VPS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=load-cloudflare-secrets.sh
source "$SCRIPT_DIR/load-cloudflare-secrets.sh"

PAYLOAD_URL="${PAYLOAD_URL:-}"
DEPLOY_REPORT_TOKEN="${DEPLOY_REPORT_TOKEN:-}"

if [ -z "$PAYLOAD_URL" ] || [ -z "$DEPLOY_REPORT_TOKEN" ]; then
  echo "PAYLOAD_URL and DEPLOY_REPORT_TOKEN are required" >&2
  exit 1
fi

WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

bash "$SCRIPT_DIR/checkout-platform.sh"
cd platform
bash "$SCRIPT_DIR/setup-node-pnpm.sh"
source "$SCRIPT_DIR/load-node-pnpm.sh"
pnpm install --frozen-lockfile

cd apps/payload
pnpm run scheduled-publish:run

echo "Scheduled publish run complete"
