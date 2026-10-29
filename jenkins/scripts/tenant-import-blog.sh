#!/usr/bin/env bash
set -euo pipefail

TENANT="${tenant_slug:-${TENANT:-}}"
GITHUB_REPO="${github_repo:-}"
GITHUB_BRANCH="${github_branch:-main}"
BLOG_PATH="${blog_content_path:-src/content/blog}"

export TENANT GITHUB_REPO GITHUB_BRANCH

if [ -z "$TENANT" ]; then
  echo "tenant_slug is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=load-cloudflare-secrets.sh
source "$SCRIPT_DIR/load-cloudflare-secrets.sh"
export GH_FALLBACK_TOKEN="${EXTERNAL_REPO_GITHUB_TOKEN:-}"
WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

bash "$SCRIPT_DIR/checkout-platform.sh"
PLATFORM="$WORKSPACE/platform"
cd "$PLATFORM"

bash "$SCRIPT_DIR/setup-node-pnpm.sh"
source "$SCRIPT_DIR/load-node-pnpm.sh"
pnpm install --frozen-lockfile

cd "$WORKSPACE"
# shellcheck source=resolve-client-github-token.sh
source "$SCRIPT_DIR/resolve-client-github-token.sh"
bash "$SCRIPT_DIR/checkout-client-repo.sh"

cd "$PLATFORM"
pnpm --filter @astropayload/payload import:blog-from-repo-api -- \
  --slug "$TENANT" \
  --site "$WORKSPACE/site" \
  --blog-path "$BLOG_PATH"

echo "Import complete for $TENANT"
