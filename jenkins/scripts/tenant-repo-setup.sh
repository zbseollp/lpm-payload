#!/usr/bin/env bash
# Tenant repo setup — mirrors .github/workflows/tenant-repo-setup.yml
set -euo pipefail

TENANT="${tenant_slug:-${TENANT:-}}"
GITHUB_REPO="${github_repo:-}"
GITHUB_BRANCH="${github_branch:-main}"
BLOG_PATH="${blog_content_path:-src/content/blog}"
PAYLOAD_URL="${PAYLOAD_URL:-}"
DEPLOY_REPORT_TOKEN="${DEPLOY_REPORT_TOKEN:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

export TENANT GITHUB_REPO GITHUB_BRANCH BLOG_PATH

if [ -z "$TENANT" ] || [ -z "$GITHUB_REPO" ]; then
  echo "tenant_slug and github_repo are required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=load-cloudflare-secrets.sh
source "$SCRIPT_DIR/load-cloudflare-secrets.sh"
WORKSPACE="${WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

bash "$SCRIPT_DIR/checkout-platform.sh"
PLATFORM="$WORKSPACE/platform"

bash "$SCRIPT_DIR/setup-node-pnpm.sh"
source "$SCRIPT_DIR/load-node-pnpm.sh"

export GH_FALLBACK_TOKEN="${EXTERNAL_REPO_GITHUB_TOKEN:-}"
# shellcheck source=resolve-client-github-token.sh
source "$SCRIPT_DIR/resolve-client-github-token.sh"
bash "$SCRIPT_DIR/checkout-client-repo.sh"

SRC="$WORKSPACE/platform/templates/site-integration"
SITE="$WORKSPACE/site"

cp "$SRC/astropayload.config.json" "$SITE/astropayload.config.json"
sed -i.bak "s/\"tenantSlug\": \"\"/\"tenantSlug\": \"${TENANT}\"/" "$SITE/astropayload.config.json"
sed -i.bak "s|\"blogContentPath\": \"src/content/blog\"|\"blogContentPath\": \"${BLOG_PATH}\"|" "$SITE/astropayload.config.json"
rm -f "$SITE/astropayload.config.json.bak"

mkdir -p "$SITE/scripts" "$SITE/.github/workflows"
cp "$SRC/scripts/sync-content.example.mjs" "$SITE/scripts/sync-content.mjs"
cp "$SRC/.github/workflows/astropayload-setup-notify.yml" "$SITE/.github/workflows/astropayload-setup-notify.yml"
mkdir -p "$SITE/$BLOG_PATH"
touch "$SITE/$BLOG_PATH/.gitkeep"

if [ ! -f "$SITE/.gitignore" ]; then touch "$SITE/.gitignore"; fi
if ! grep -q 'astropayload.config.json' "$SITE/.gitignore" 2>/dev/null; then
  {
    echo ""
    echo "# Local Payload credentials (optional for dev sync)"
    echo ".env.astropayload"
  } >> "$SITE/.gitignore"
fi

cd "$SITE"
git config user.name "astropayload-bot"
git config user.email "bot@users.noreply.github.com"

BRANCH="astropayload/setup-${TENANT}-$(date +%Y%m%d)"
git checkout -b "$BRANCH"
git add -A

PR_URL=""
PR_NUM=""
if git diff --staged --quiet; then
  echo "No changes to commit — integration may already exist."
else
  git commit -m "chore: add Astropayload blog integration for ${TENANT}"
  CLIENT_TOKEN="${CLIENT_GITHUB_TOKEN:-${EXTERNAL_REPO_GITHUB_TOKEN:-}}"
  git push "https://x-access-token:${CLIENT_TOKEN}@github.com/${GITHUB_REPO}.git" "$BRANCH"

  if command -v gh >/dev/null 2>&1 && [ -n "$GH_TOKEN" ]; then
    export GH_TOKEN
    gh pr create \
      --title "Astropayload: blog integration for ${TENANT}" \
      --body "Adds astropayload.config.json, optional local sync script, blog folder, and a workflow that marks setup **ready** in Payload when this PR merges." \
      --base "$GITHUB_BRANCH" \
      --head "$BRANCH" || true
    PR_URL="$(gh pr view --json url -q .url 2>/dev/null || true)"
    PR_NUM="$(gh pr view --json number -q .number 2>/dev/null || true)"
  fi
fi

cd "$WORKSPACE/platform"
pnpm install --frozen-lockfile

if [ -n "$PR_URL" ]; then
  pnpm --filter @astropayload/payload report:github-setup -- \
    --slug "$TENANT" \
    --status setup_dispatched \
    --pr-url "$PR_URL" \
    --notes "Setup PR opened from Jenkins." || true
fi

if [ -n "$PR_NUM" ] && command -v gh >/dev/null 2>&1 && [ -n "$GH_TOKEN" ]; then
  export GH_TOKEN
  for _ in $(seq 1 60); do
    MERGED="$(gh pr view "$PR_NUM" --repo "$GITHUB_REPO" --json merged -q .merged 2>/dev/null || echo false)"
    if [ "$MERGED" = "true" ]; then
      break
    fi
    sleep 30
  done

  MERGED="$(gh pr view "$PR_NUM" --repo "$GITHUB_REPO" --json merged -q .merged 2>/dev/null || echo false)"
  if [ "$MERGED" = "true" ]; then
    pnpm --filter @astropayload/payload auto-import-blog-if-empty -- \
      --slug "$TENANT" \
      --site "$SITE" \
      --blog-path "$BLOG_PATH" || true

    pnpm --filter @astropayload/payload report:github-setup -- \
      --slug "$TENANT" \
      --status ready \
      --pr-url "$PR_URL" \
      --notes "Setup PR merged (detected by Jenkins poll)." || true
  fi
fi

echo "Setup complete for $TENANT"
