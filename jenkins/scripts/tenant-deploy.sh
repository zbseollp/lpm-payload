#!/usr/bin/env bash
# Tenant deploy — mirrors .github/workflows/tenant-deploy.yml
set -euo pipefail

TENANT="${tenant_slug:-${TENANT:-}}"
DEPLOY_MODE="${deploy_mode:-monorepo}"
GITHUB_REPO="${github_repo:-}"
GITHUB_BRANCH="${github_branch:-main}"
BLOG_CONTENT_PATH="${blog_content_path:-src/content/blog}"
RUN_URL="${BUILD_URL:-}"
PAYLOAD_URL="${PAYLOAD_URL:-}"
DEPLOY_REPORT_TOKEN="${DEPLOY_REPORT_TOKEN:-}"
CLOUDFLARE_WORKERS_DEV_SUBDOMAIN="${CLOUDFLARE_WORKERS_DEV_SUBDOMAIN:-}"

export TENANT DEPLOY_MODE GITHUB_REPO GITHUB_BRANCH BLOG_CONTENT_PATH

if [ -z "$TENANT" ]; then
  echo "tenant_slug parameter is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

# Astro content sync can exceed Node's default ~4GB heap for large blog collections.
ensure_astro_heap() {
  if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${ASTRO_BUILD_HEAP_MB:-8192}"
  fi
}

bash "$SCRIPT_DIR/checkout-platform.sh"
PLATFORM="$WORKSPACE/platform"
cd "$PLATFORM"

bash "$SCRIPT_DIR/setup-node-pnpm.sh"
# shellcheck source=load-node-pnpm.sh
source "$SCRIPT_DIR/load-node-pnpm.sh"
pnpm install --frozen-lockfile

if [ "$DEPLOY_MODE" = "external" ] && [ -n "$GITHUB_REPO" ]; then
  export GH_FALLBACK_TOKEN="${EXTERNAL_REPO_GITHUB_TOKEN:-}"
  # shellcheck source=resolve-client-github-token.sh
  source "$SCRIPT_DIR/resolve-client-github-token.sh"
  bash "$SCRIPT_DIR/checkout-client-repo.sh"
  SITE_ROOT="$WORKSPACE/site"
else
  SITE_ROOT="$PLATFORM/apps/sites/$TENANT"
fi

if [ -n "$PAYLOAD_URL" ] && [ -n "$DEPLOY_REPORT_TOKEN" ]; then
  pnpm --filter @astropayload/payload auto-import-blog-if-empty -- \
    --slug "$TENANT" \
    --site "$SITE_ROOT" \
    --blog-path "$BLOG_CONTENT_PATH" || true
fi

if [ -n "$PAYLOAD_URL" ] && [ -n "$DEPLOY_REPORT_TOKEN" ] && [ -n "$RUN_URL" ]; then
  pnpm --filter @astropayload/payload report:deploy -- \
    --slug "$TENANT" \
    --status in_progress \
    --run-url "$RUN_URL" || true
fi

WORKERS_URL=""

# Prefer per-tenant / Default Cloudflare credential from Payload; keep Jenkins CLOUDFLARE_* as fallback.
# shellcheck source=resolve-cloudflare-credentials.sh
source "$SCRIPT_DIR/resolve-cloudflare-credentials.sh"

if [ "$DEPLOY_MODE" = "external" ]; then
  cd "$PLATFORM"
  pnpm tenant-cli sync --slug "$TENANT" --site "$SITE_ROOT" --blog-path "$BLOG_CONTENT_PATH"

  cd "$SITE_ROOT"
  export CI=true
  export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

  if [ ! -f wrangler.toml ] && [ ! -f wrangler.json ] && [ ! -f wrangler.jsonc ]; then
    echo "ERROR: Client repo is missing wrangler.toml (or wrangler.jsonc)." >&2
    echo "  Add Cloudflare Workers config + @astrojs/cloudflare before CI deploy." >&2
    exit 1
  fi

  if [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile
    PKG=pnpm
  elif [ -f package-lock.json ]; then
    npm ci
    PKG=npm
  else
    npm install
    PKG=npm
  fi

  export TENANT
  # Optional per-tenant dotenv (hCaptcha, Web3Forms, PUBLIC_*, etc.) → SITE_ROOT/.env
  # shellcheck source=load-client-build-env.sh
  source "$SCRIPT_DIR/load-client-build-env.sh"
  ensure_astro_heap
  if [ "$PKG" = "pnpm" ]; then pnpm run build; else npm run build; fi

  # Deploy only — do not run "npm run deploy" (may re-build or trigger wrangler init).
  set -o pipefail
  if [ "$PKG" = "pnpm" ]; then
    if ! pnpm exec wrangler --version >/dev/null 2>&1; then
      echo "Installing wrangler (missing from client package.json)"
      pnpm add -D wrangler@^4.84.0
    fi
    pnpm exec wrangler deploy 2>&1 | tee deploy.log
  else
    if ! npx wrangler --version >/dev/null 2>&1; then
      echo "Installing wrangler (missing from client package.json)"
      npm install -D wrangler@^4.84.0
    fi
    npx wrangler deploy 2>&1 | tee deploy.log
  fi
  WORKERS_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' deploy.log | tail -1 || true)"
else
  if [ ! -d "$PLATFORM/apps/sites/$TENANT" ]; then
    echo "No monorepo site at apps/sites/$TENANT" >&2
    exit 1
  fi
  FILTER="@astropayload/site-${TENANT}"
  cd "$PLATFORM"
  pnpm --filter "$FILTER" sync:content
  # Optional per-tenant dotenv for monorepo sites
  # shellcheck source=load-client-build-env.sh
  source "$SCRIPT_DIR/load-client-build-env.sh"
  ensure_astro_heap
  pnpm --filter "$FILTER" build
  pnpm --filter "$FILTER" deploy 2>&1 | tee deploy.log
  WORKERS_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' deploy.log | tail -1 || true)"
fi

if [ -n "$PAYLOAD_URL" ] && [ -n "$DEPLOY_REPORT_TOKEN" ]; then
  cd "$PLATFORM"
  pnpm --filter @astropayload/payload report:deploy -- \
    --slug "$TENANT" \
    --status success \
    --workers-url "$WORKERS_URL" \
    --run-url "$RUN_URL" || true
fi

echo "Deploy complete for $TENANT"
