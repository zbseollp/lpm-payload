# Production Playbook — A to Z

How this system actually runs in production: which services hold what, how a content edit becomes a live deploy, how to onboard a new tenant, how versioning works, and how to recover when things go wrong.

For the per-command reference, see [COMMANDS.md](./COMMANDS.md).

---

## 0. The picture

```
┌─────────────────┐       ┌─────────────────┐       ┌────────────────────┐
│  Content editor │─edit─▶│  Payload CMS    │──hook▶│  Webhook (CF Worker)│
│  (web browser)  │       │  (Cloudflare /  │       └─────────┬──────────┘
└─────────────────┘       │   any Node host)│                 │ workflow_dispatch
                          └────────┬────────┘                 ▼
                                   │ reads/writes      ┌─────────────────┐
                                   ▼                   │ GitHub Actions  │
                          ┌─────────────────┐          │ tenant-deploy   │
                          │  Postgres       │          └────────┬────────┘
                          │  (Neon)         │                   │
                          └─────────────────┘                   │ sync + build + deploy
                          ┌─────────────────┐                   ▼
                          │  Cloudflare R2  │          ┌─────────────────┐
                          │  (media files)  │          │ Cloudflare      │
                          └─────────────────┘          │ Worker per      │
                                                       │ tenant          │
                                                       │ (Astro hybrid)  │
                                                       └────────┬────────┘
                                                                ▼
                                                       ┌─────────────────┐
                                                       │ end users on    │
                                                       │ tenant domains  │
                                                       └─────────────────┘
```

| Service | What lives here | Per-tenant or shared? |
|---|---|---|
| **Postgres (Neon)** | Tenants, content rows, users, redirects, nav menus | **Shared** (one DB, every row stamped with `tenant_id`) |
| **Payload CMS** | The Next.js admin UI + REST/GraphQL API | **Shared** (one deployment, multi-tenant scoped) |
| **Cloudflare R2** | Media uploads (images, OG cards, logos) | **Shared bucket**, prefixed `tenants/<slug>/...` |
| **Cloudflare Worker (webhook)** | Receives Payload `afterChange` events, dispatches GitHub Actions | **Shared** |
| **Cloudflare Worker (each tenant)** | The compiled Astro hybrid output for one tenant | **Per-tenant** (1 worker × 100–1000 tenants) |
| **GitHub Actions** | Runs the sync → build → deploy pipeline | **Shared** (one workflow, parameterized by `tenant_slug`) |

---

## 1. One-time production setup

Do this once when standing up production for the first time.

### 1.1 Provision Postgres

**Recommended**: Neon (serverless, free tier sufficient for a few hundred tenants).

1. Sign up at https://neon.tech.
2. Create a project (e.g. `astropayload-prod`).
3. Branches: keep `main` for production; create a `staging` branch for safe migrations.
4. Copy the **Pooled connection string** (looks like `postgres://user:pass@ep-...-pooler.region.aws.neon.tech/neondb?sslmode=require`).

Alternatives: AWS RDS, Supabase, Render, any managed Postgres ≥ 15.

### 1.2 Provision R2 (media bucket)

1. Cloudflare dashboard → **R2** → **Create bucket** → name e.g. `astropayload-media`.
2. **Settings → Public access** → either enable the `*.r2.dev` URL (dev) or attach a custom domain like `media.yourcompany.com` (recommended for prod — better caching, branded URLs).
3. **Settings → CORS policy** → allow GET from all your tenant domains (or `*` while you're getting started).
4. **Manage R2 API Tokens** → **Create API Token** → scope it to "Object Read & Write" on this bucket. **Copy the access key + secret once** (Cloudflare only shows them at creation).
5. Set **`R2_PUBLIC_URL`** in Payload `.env` to the bucket's **public** URL (the `*.r2.dev` link or your custom domain like `https://media.yourcompany.com`). This is **not** the S3 API endpoint (`*.r2.cloudflarestorage.com`) — that one is for uploads only.

### 1.3 Provision the Payload CMS host

Payload is a Next.js app, so options are:

| Host | Pros | Cons |
|---|---|---|
| **Vercel** | Native Next.js support, near-zero config | Function timeouts can bite long admin operations |
| **Cloudflare Pages + Workers** | Same stack as the sites | Some Payload features need a Node runtime |
| **Railway / Render / Fly** | Long-running Node containers | Manage scaling yourself |
| **Self-hosted (Docker)** | Full control | You operate it |

Recommended for this stack: **Railway** or **Fly.io** — keeps Payload as a stable long-running process with persistent connections to Postgres + R2.

Deployment looks like:
```sh
cd apps/payload
# Set env vars on the platform (do NOT commit these):
#   PAYLOAD_SECRET (rotate from dev!)
#   PAYLOAD_PUBLIC_SERVER_URL=https://cms.yourcompany.com
#   DATABASE_URI=<neon pooled connection string>
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
#   WEBHOOK_URL=https://webhook.yourcompany.workers.dev/payload
#   WEBHOOK_TOKEN=<shared secret, see step 1.4>
pnpm build
pnpm start   # or platform-specific deploy
```

First-time boot will auto-create all tables in Postgres (because `push: true` in `payload.config.ts` during non-production). For production, switch to **migrations** — see §6.

### 1.4 Provision the webhook worker

```sh
cd apps/webhook
wrangler login                                # once
wrangler secret put WEBHOOK_TOKEN             # generate: openssl rand -hex 24
wrangler secret put GITHUB_TOKEN              # fine-grained PAT, Actions: R+W
wrangler deploy
# Note the URL it prints, e.g. https://astropayload-webhook.<account>.workers.dev
```

Then go back to your Payload host and set `WEBHOOK_URL=<that URL>/payload` and `WEBHOOK_TOKEN=<same value>`.

### 1.5 Provision the first tenant Worker (keukenfaqs)

```sh
pnpm install
cp apps/sites/keukenfaqs/.env.example apps/sites/keukenfaqs/.env
# Edit .env: PAYLOAD_URL=https://cms.yourcompany.com  PAYLOAD_API_KEY=<key>

# Pull the latest content snapshot from Payload
pnpm keukenfaqs:sync

# Deploy
pnpm keukenfaqs:deploy
```

Cloudflare assigns a `*.workers.dev` URL by default. To attach a custom domain (`keukenfaqs.nl`):
1. Cloudflare dashboard → **Workers & Pages** → click the worker → **Settings → Triggers → Custom Domains**.
2. Add `keukenfaqs.nl` and `www.keukenfaqs.nl`.
3. Cloudflare automatically provisions an SSL cert and routes traffic.

### 1.6 Set GitHub Actions secrets

In the repo settings → **Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with Workers Scripts:Edit on your account |
| `CLOUDFLARE_ACCOUNT_ID` | Found in Cloudflare dashboard right sidebar |
| `PAYLOAD_URL` | Your CMS URL, e.g. `https://cms.yourcompany.com` |
| `PAYLOAD_API_KEY` | A dedicated CI user's API key (super-admin; don't reuse your personal one) |
| `DEPLOY_REPORT_TOKEN` | **Recommended.** Same value as `DEPLOY_REPORT_TOKEN` in Payload `.env` on the CMS server. CI sends header `x-deploy-report-token`. Without this (and without a valid super-admin `PAYLOAD_API_KEY`), deploy status reports return 401. |
| `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` | Optional. Account workers.dev subdomain used to build `https://<slug>.<subdomain>.workers.dev` when wrangler output cannot be parsed |
| `EXTERNAL_REPO_GITHUB_TOKEN` | **Required for external client repos.** Fine-grained or classic PAT with **read** access to each client repo (e.g. `zbseollp/keukenfaqs`). The built-in `GITHUB_TOKEN` only sees the astropayload repo — checkout of other repos fails with "Repository not found". Can be the same PAT as Payload `GITHUB_TOKEN` if scoped to those repos. |
| `DEPLOY_REPORT_TOKEN` | **Required for CI blog import** (`POST /api/tenants/import-blog-content`). Same value as on the CMS server. |
| `PAYLOAD_API_KEY` | Optional for auto-import if not using `DEPLOY_REPORT_TOKEN`; must be a **super-admin** API key (tenant editors get 403 on `POST /api/blog-posts`). |

These get injected into `tenant-deploy.yml`, `tenant-scaffold.yml`, and `tenant-repo-setup.yml` at runtime. **Do not** add `DATABASE_URI` or `PAYLOAD_SECRET` to GitHub — CI never connects to Postgres directly.

**External client repos** (tenant has `githubRepo` set): the PAT above must be able to **read** the client repo and open setup PRs. After the setup PR merges, either the platform workflow polls for merge (30 min) or the client repo workflow notifies Payload — add on the **client** repo:

| Secret | Value |
|---|---|
| `ASTROPAYLOAD_URL` | Same as platform `PAYLOAD_URL` |
| `ASTROPAYLOAD_REPORT_TOKEN` | Same as platform `DEPLOY_REPORT_TOKEN` |

See [ONBOARDING.md](./ONBOARDING.md) section **C** for the full external-repo SOP.

### 1.7 Best practice — rotate the dev secrets

Local dev shares `PAYLOAD_SECRET` and a personal API key. **Never reuse them in production**:

```sh
# Production PAYLOAD_SECRET — a different value than local
openssl rand -hex 32

# Production API key for CI — generate by creating a dedicated "ci" user in
# Payload admin (Users → Add User) and enabling the API Key on that user,
# instead of giving CI access to your personal admin account.
```

---

## 1.8 Self-hosted Payload on a VPS (PM2)

Typical path: clone to `/var/www/astropayload`, configure `apps/payload/.env`, run Payload behind nginx on port 3000.

### One-time on the server

```sh
# Node 22+ and pnpm (example on Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
npm install -g pnpm pm2

cd /var/www
git clone https://github.com/YOUR_ORG/astropayload.git
cd astropayload
cp apps/payload/.env.example apps/payload/.env
# Edit .env: DATABASE_URI, PAYLOAD_SECRET, PAYLOAD_PUBLIC_SERVER_URL, R2_*, GITHUB_*, etc.

sudo mkdir -p /var/log/payload
sudo chown "$USER:$USER" /var/log/payload

chmod +x scripts/vps-deploy-payload.sh
./scripts/vps-deploy-payload.sh --first-run
pm2 startup   # run the command it prints, then: pm2 save
```

### Every deploy (pull + build + restart)

```sh
cd /var/www/astropayload
./scripts/vps-deploy-payload.sh
```

After changing `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` or other build-time env:

```sh
./scripts/vps-deploy-payload.sh --fresh
```

Useful commands:

```sh
pm2 status
pm2 logs payload --lines 200
pm2 reload payload
```

Process config: `ecosystem.config.cjs` at repo root. **Tenant sites** still deploy via GitHub Actions (Publish in admin), not via this VPS script.

If admin returns 500 with `column ... does not exist` after a code update, production Postgres is behind the app (push is off in production). Run once:

```sh
psql "$DATABASE_URI" -f apps/payload/scripts/sync-prod-schema.sql
./scripts/vps-deploy-payload.sh --fresh
```

(`vps-deploy-payload.sh` runs this SQL automatically when `psql` and `DATABASE_URI` are available in `apps/payload/.env`.)

---

## 2. Day-2 content authoring flow (the happy path)

This is what your editors will do 99% of the time. **No CLI involved.**

1. **Editor opens** `https://cms.yourcompany.com/admin` and logs in.
2. **Selects a tenant** from the top-left dropdown (e.g. "KeukenFAQs"). The multi-tenant plugin scopes every query to that tenant.
3. **Edits blog posts** and clicks **Save** as many times as needed. Changes are stored in Postgres only — **the public site does not update yet**.
4. When all edits are ready, clicks **Publish content to live site** (green bar on content list/edit screens, or on the Tenant row for super-admins). The UI shows the deploy target: **Monorepo** (`apps/sites/<slug>`) or **External repo** (`owner/repo`).
5. Payload dispatches `tenant-deploy.yml` on GitHub (one run per publish click).
6. **GitHub Actions**: sync blog from Payload → `build` → `wrangler deploy` (monorepo or checked-out client repo).
7. **End users** see changes at `https://<tenant-domain>` (or `*.workers.dev` before custom domain) within ~30–90 seconds after publish finishes.

**Saving ≠ live.** Only **Publish** pushes CMS content to the static site.

### Important: only the affected tenant rebuilds

The other 99–999 tenants are untouched. Their workers don't redeploy, their builds don't run, their cache stays warm. This is the entire reason for the per-tenant Worker architecture.

---

## 3. Onboarding a new tenant (A to Z)

You want to add `kookhulpjes.nl` to the platform. There are two ways: the **dashboard flow** (recommended — no terminal needed) and the **CLI flow** (for power users).

### Option A — Dashboard flow (recommended)

Prereq: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` are set in `apps/payload/.env`. The token needs `actions:write`, `contents:write`, `pull_requests:write` scopes (easiest: fine-grained PAT scoped to this repo).

1. **Admin → Tenants → "Create New"**. Fill slug (`kookhulpjes`), domain (`kookhulpjes.nl`), name (`Kookhulpjes`), the Branding/SEO/Analytics/Deploy tabs as needed. Click **Save**.
2. **A "Tenant actions" box appears at the top of the saved tenant row.** Click **"Scaffold tenant code"**.
3. Within ~30 seconds, the green box says *"Scaffold dispatched for kookhulpjes. A pull request will appear on GitHub within ~30 seconds."* Click the **"View workflow runs on GitHub →"** link to watch it.
4. GitHub shows a new PR titled *"Scaffold tenant: kookhulpjes"*. Review the diff (a new `apps/sites/kookhulpjes/` folder). **Click Merge**.
5. Back in the Payload admin, click **"Deploy now"** on the same tenant row. The site builds and deploys in ~2 minutes.
6. **One last manual step**: Cloudflare dashboard → the `kookhulpjes` Worker → **Triggers → Custom Domains** → add `kookhulpjes.nl`.

After deploy finishes, the tenant edit screen shows **Site URLs** (production, workers.dev, preview) and **Latest deploy** status — updated automatically by CI.

Done. Total clicks: ~6. Zero terminal commands.

What happens under the hood:
- Step 2 → `POST /api/tenants/:id/scaffold` → `dispatchWorkflow('tenant-scaffold.yml', { tenant_slug, tenant_domain, tenant_name })` → GitHub Action runs `pnpm tenant-cli create --slug ... --skip-payload-create`, commits, pushes branch `scaffold/kookhulpjes`, opens a PR via `gh pr create`.
- Step 5 → `POST /api/tenants/:id/deploy` → `dispatchWorkflow('tenant-deploy.yml', { tenant_slug })` → existing deploy pipeline runs.

### Option B — CLI flow (advanced)

### 3.1 Scaffold the code

```sh
# Set env so the CLI can also create the Payload row
export PAYLOAD_URL=https://cms.yourcompany.com
export PAYLOAD_API_KEY=<ci-user-key>

pnpm tenant-cli create \
  --slug kookhulpjes \
  --domain kookhulpjes.nl \
  --name "Kookhulpjes"
```

This:
- Creates `apps/sites/kookhulpjes/` (copied from the keukenfaqs template, minus content).
- Sets the pnpm package name to `@astropayload/site-kookhulpjes`.
- Sets the Wrangler Worker name to `kookhulpjes`.
- Writes a placeholder `tenant.config.json`.
- POSTs to `https://cms.yourcompany.com/api/tenants` to create the Payload row.

Pass `--skip-payload-create` if the tenant row already exists (this is what the dashboard flow's CI does internally).

### 3.2 Pick up the new workspace

```sh
pnpm install                 # discovers apps/sites/kookhulpjes via pnpm-workspace.yaml
```

### 3.3 (Optional) migrate existing WordPress content

If kookhulpjes is migrating from WordPress:

```sh
# Posts + pages
pnpm --filter @astropayload/payload run migrate:wxr \
  --wxr ./kookhulpjes-wp-export.xml \
  --slug kookhulpjes \
  --domain kookhulpjes.nl

# Scraped money pages (if applicable)
pnpm --filter @astropayload/payload run migrate:money-pages \
  --slug kookhulpjes \
  --scraped-dir ./kookhulpjes-money-pages

# Dropped URLs → redirects
pnpm --filter @astropayload/payload run migrate:redirects \
  --slug kookhulpjes \
  --tsv ./kookhulpjes-dropped-urls.txt \
  --target /
```

### 3.4 Configure tenant identity in the admin

Admin → Tenants → Kookhulpjes:
- **Branding tab**: upload logo, favicon, OG image; pick theme colors.
- **SEO tab**: set siteTitle, siteDescription, robots, titleSuffix.
- **Analytics tab**: GA4 ID, GTM ID, Plausible domain (optional).
- **Affiliate tab**: Bol.com publisher ID, Awin, Amazon tag (optional).
- **Social tab**: array of platform/URL pairs.
- **Deploy tab**: `cloudflareProject` (defaults to slug), `githubWorkflow` (defaults to `tenant-deploy.yml`), `webhookEnabled` (default true).

### 3.5 First deploy

```sh
# Pull content + identity, build, deploy
pnpm tenant-cli deploy --slug kookhulpjes
```

Or trigger via GitHub Actions:

```sh
gh workflow run tenant-deploy.yml -f tenant_slug=kookhulpjes
```

### 3.6 Attach the custom domain

Cloudflare dashboard → Worker `kookhulpjes` → **Triggers → Custom Domains** → add `kookhulpjes.nl` and `www.kookhulpjes.nl`.

If the domain is at a different registrar, change the nameservers to Cloudflare's first.

### 3.7 What changed in the codebase

Just one folder:

```
apps/sites/kookhulpjes/         ← new
```

**Zero** edits to:
- The root `package.json`
- The Payload app (just one new DB row, no code change)
- `apps/webhook/`
- `.github/workflows/`
- Any other tenant under `apps/sites/`

This is why the architecture scales linearly with tenants but O(1) for code.

---

## 4. Versioning strategy

This monorepo uses **trunk-based development** with feature branches and squash merges. No published packages, no semver — everything is internal.

### Branching model

```
main         ──●──●──●──●──●──●─────────▶  (always deployable)
                  ╲             ╱
                   ●──●──●──●──●           feature/keukenfaqs-redesign
```

- **`main`**: always green, always deployable. Direct pushes are blocked; everything merges via PR.
- **Feature branches**: `feature/<short-description>` or `fix/<short>`. One branch per piece of work.
- **PR**: branch → main, squash merge. CI must pass (typecheck + lint + build).

### What's versioned in git vs Payload

| Lives in git | Lives in Payload (Postgres) |
|---|---|
| Astro pages, layouts, components, styles | Content (blog posts, pages, money pages) |
| Build/deploy configs | Tenant identity (name, theme, SEO, analytics) |
| Migration scripts | Media uploads (file rows; bytes in R2) |
| Webhook + tenant-cli code | Users, API keys, redirects |
| GitHub Actions workflows | Anything an editor can change |

This split is intentional. Developers move at git's pace (PRs, reviews, CI). Editors move at Payload's pace (save → live in 60s). They never block each other.

### When code changes affect production

Code changes (`apps/sites/<slug>/src/**`, `apps/payload/**`, `packages/**`) are **not** auto-deployed to tenant Workers. Editors saving content triggers deploys via the webhook; code changes need an explicit trigger:

```sh
# Re-deploy a single tenant after code change
gh workflow run tenant-deploy.yml -f tenant_slug=keukenfaqs

# Re-deploy all tenants (slower; usually CI does this in batch on main)
for slug in $(jq -r '.[].slug' tenants.json); do
  gh workflow run tenant-deploy.yml -f tenant_slug=$slug
done
```

For wider sweeps, add a separate workflow that does a matrix over tenants.

### Tagging releases (optional)

If you want auditable "production at commit X" markers, tag `main` periodically:

```sh
git tag -a v2026-05-13 -m "Production deploy 2026-05-13"
git push origin v2026-05-13
```

The Cloudflare Worker dashboard also keeps the last ~10 deploys per worker, with rollback available, so explicit tags are optional.

### Rollback

| Scope | How |
|---|---|
| One tenant, latest deploy | Cloudflare dashboard → Worker → Deployments → "Rollback" |
| One tenant, code regression | Revert the offending PR, then `gh workflow run tenant-deploy.yml -f tenant_slug=<slug>` |
| All tenants, code regression | Revert PR; trigger workflow for all tenants |
| Payload data corruption | Restore Postgres from Neon point-in-time backup; redeploy affected tenants |

---

## 5. The CI/CD pipeline in detail

### `.github/workflows/tenant-deploy.yml`

The single workflow that handles all tenant deploys. Triggered by:
1. **`workflow_dispatch`** from the webhook worker (on content change in Payload).
2. **`workflow_dispatch`** manually from the CLI or GitHub UI (for code changes).

```yaml
on:
  workflow_dispatch:
    inputs:
      tenant_slug:
        required: true
        type: string

concurrency:
  group: tenant-deploy-${{ inputs.tenant_slug }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm tenant-cli sync --slug ${{ inputs.tenant_slug }}
        env:
          PAYLOAD_URL: ${{ secrets.PAYLOAD_URL }}
          PAYLOAD_API_KEY: ${{ secrets.PAYLOAD_API_KEY }}
      - run: pnpm --filter @astropayload/site-${{ inputs.tenant_slug }} run build
      - run: pnpm --filter @astropayload/site-${{ inputs.tenant_slug }} exec wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

### Key properties

| Property | Why it matters |
|---|---|
| `concurrency.group` keyed by slug | Two saves on the same tenant within 30s → only one deploy runs. |
| `cancel-in-progress: true` | A newer save cancels the older in-flight build instantly. |
| `--frozen-lockfile` | Guarantees reproducible builds; CI fails if `pnpm-lock.yaml` is out of date. |
| `pnpm tenant-cli sync` | Pulls **only this tenant's** content slice — no full-DB dump. |
| `pnpm --filter` | Only this tenant's app is touched; the other 99 don't reinstall, don't rebuild. |
| Step ordering | Sync first (cheap; ~5s), build second (expensive; ~2min), deploy last (fast; ~10s). Failure of any step skips later ones. |

### Average pipeline latency

Roughly **60–90 seconds** end-to-end (editor save → live on `<tenant-domain>`):

| Step | Time |
|---|---|
| Payload `afterChange` → webhook POST | ~100ms |
| Webhook → `workflow_dispatch` API call | ~300ms |
| GitHub Actions queue (cold) | 5–30s |
| `pnpm install --frozen-lockfile` (Turbo + pnpm cache) | 5–15s |
| `tenant-cli sync` (REST queries) | 3–10s |
| `astro build` | 30–90s (scales with content volume) |
| `wrangler deploy` | 5–10s |
| Cloudflare propagation | 5–15s |

### Observability

| Where to look | What you'll find |
|---|---|
| GitHub Actions run logs | Full build + deploy output per tenant |
| Cloudflare Worker logs (webhook) | `wrangler tail` shows every incoming event + dispatch result |
| Cloudflare Worker logs (each tenant) | Request-level logs, errors, durations |
| Neon Postgres console | Slow query log, connection count |
| Payload admin → System → Job Queue (if enabled) | Background job status |

---

## 6. Database migrations in production

In development, `apps/payload/src/payload.config.ts` has `db: postgresAdapter({ ..., push: true })` when `NODE_ENV !== 'production'`. This means Payload auto-syncs your collection schemas to Postgres on every dev server start — fast and frictionless.

**In production, `push` is automatically off**, and you must use Payload's migrations:

```sh
# Create a migration after a collection change
cd apps/payload
pnpm payload migrate:create my-change-description

# Inspect the generated SQL file in apps/payload/src/migrations/
# Commit it. Then on next prod deploy:

pnpm payload migrate
```

Migrations run during the CMS deploy, before the new image takes traffic. They're transactional — if any statement fails, the migration rolls back.

For destructive changes (rename a field, drop a collection):
1. Do a **two-phase** migration: write a migration that adds the new shape, ships, backfills data, then ships a follow-up migration removing the old shape.
2. Use Neon's branching to run the migration on a staging branch first, verify, then merge to main.

---

## 7. Security checklist

### Admin two-factor authentication (2FA)

All admin users (Super Admin, Tenant Admin, and Editor) must set up TOTP 2FA before using the Payload admin panel. After the first password login, users are redirected to scan a QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.). Subsequent logins require email, password, and a 6-digit code.

- Implemented via [`payload-totp`](https://github.com/GeorgeHulpoi/payload-totp) on the `users` collection (`forceSetup: true`).
- Optional env: `PAYLOAD_TOTP_ISSUER` — label shown in authenticator apps (default `LMP`).
- **API keys are unaffected** — CI and Astro builds continue to authenticate with `Authorization: users API-Key …` without TOTP.
- Public content reads (`tenants`, `blog-posts`, `media`) remain unauthenticated for build-time fetches.
- **After first deploy with 2FA**, run `psql "$DATABASE_URI" -f apps/payload/scripts/sync-prod-schema.sql` on the VPS (adds `users.totp_secret`). Without this column, admin login returns `column users.totp_secret does not exist`.
- **`PAYLOAD_PUBLIC_SERVER_URL`** must match the browser URL (e.g. `https://payload.10beste.com`). Wrong values break server-side redirects to `/admin/setup-totp`.
- If login succeeds but the UI stays on the login form until refresh, redeploy with `TotpHardRedirect` (full-page navigation to setup/verify) and ensure `users` has `totp.disableAccessWrapper.read` so `/api/users/me` is not 403 on the verify page.

### Secrets handling

| Secret | Where it lives | Rotation cadence |
|---|---|---|
| `PAYLOAD_SECRET` | Payload host env vars | Yearly, or immediately on suspected leak |
| `DATABASE_URI` | Payload host env vars | When Neon credentials rotate |
| `R2_*` keys | Payload host env vars | Yearly, or on suspected leak |
| `WEBHOOK_TOKEN` | Both Payload env AND `wrangler secret` on webhook | Yearly |
| `GITHUB_TOKEN` | `wrangler secret` on webhook | Per token expiry (max 1 year for fine-grained PATs) |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Yearly |
| `PAYLOAD_API_KEY` (per user) | Per-user, in their admin profile | Per user, on offboarding |

**Never commit any of these to git.** All `.env.example` files in this repo show the **shape** only; the real `.env` is gitignored.

### Multi-tenant isolation

The `@payloadcms/plugin-multi-tenant` configuration in `payload.config.ts`:
- Adds a `tenant` relationship field to every content collection.
- Filters every list/find query by `tenant_id = currentUser.activeTenant`.
- Allows super-admins (`roles[] includes 'super-admin'`) to see all tenants.

To audit isolation:
```sh
# As a non-super-admin user, verify they can't see other tenants' content via API:
curl -H "Authorization: users API-Key $TENANT_USER_KEY" \
  https://cms.yourcompany.com/api/blog-posts?limit=1
# Should return only this user's tenant's posts.
```

### Webhook signature verification

The webhook worker checks `x-webhook-token` against `env.WEBHOOK_TOKEN`. Use a long (≥24 byte hex) token. Worth adding HMAC signing later if you'll have many integrations sending to it; for one origin (Payload), shared-secret is sufficient.

### API surface

Payload exposes both REST and GraphQL by default. For prod:
- Keep REST/GraphQL behind your CMS domain only (not on tenant domains).
- For each tenant Astro Worker, only the **`PAYLOAD_API_KEY`** for that tenant's CI user is needed — and that's set in CI secrets, not shipped to the browser.
- The tenant Astro app **never** talks to Payload from the browser. All content fetches happen at build time inside CI.

---

## 8. Scaling considerations

### From 1 → 100 tenants

| Concern | What grows | Mitigation |
|---|---|---|
| Postgres rows | Linear (one row per content item) | Neon scales transparently; add indexes if listing queries slow down |
| R2 storage | Linear (one prefix per tenant) | R2 has no per-bucket size limit |
| Cloudflare Workers | One Worker deploy per tenant | Cloudflare's free tier allows 100 Workers; paid plans go to 500+ |
| GitHub Actions minutes | One run per content save × tenants | `concurrency.cancel-in-progress` keeps this bounded; budget ~3min × edits/day × tenants |
| pnpm install time in CI | Constant (one `pnpm install` per workflow run) | Cache restore from `~/.pnpm-store` keeps it under 15s warm |

### From 100 → 1000 tenants

A few thresholds to watch:

1. **Cloudflare Workers count**. Each tenant = 1 Worker. Cloudflare allows up to **500 Workers on the Standard plan** ($5/mo) per account. For 1000+, either:
   - Upgrade to Cloudflare Enterprise (no limit).
   - Or use a **multi-tenant routing Worker** that looks up the requested host header, fetches the right tenant's pre-rendered HTML from R2 / KV, and serves it. Trades per-tenant deploys for shared infra.

2. **GitHub Actions concurrency**. The free plan allows 20 concurrent jobs. If 50 editors save in 1 minute on different tenants, 30 jobs queue. Mitigation: GitHub paid plan, or split tenants across multiple GH repos.

3. **Postgres connections**. Neon's pooled connection string handles thousands of concurrent clients fine; verify pool size in your Payload host.

4. **Build matrix workflows**. For mass redeploys (e.g. after a shared dependency upgrade), use a matrix workflow that batches 10 tenants per job:
   ```yaml
   jobs:
     deploy:
       strategy:
         matrix:
           tenant: [keukenfaqs, kookhulpjes, ...]
       steps: [...]
   ```

### Cost rough order

For ~100 tenants, ~100k pageviews/day, ~10 content edits/day:

| Service | Plan | ~Monthly cost |
|---|---|---|
| Neon Postgres | Free → Pro | $0 → $19 |
| Cloudflare Workers | Free → Workers Paid | $0 → $5 |
| Cloudflare R2 | Pay-as-you-go (10GB+) | $0.15/GB stored, $0 egress |
| GitHub Actions | Free for public, 2k min/mo for private | $0 → $40 |
| Payload CMS host (Railway/Fly) | Hobby | $5–20 |
| **Total** | | **~$5–80/mo for 100 tenants** |

For 1000 tenants, swap to Cloudflare Workers Paid + Neon Scale + GitHub Actions Team — still under $500/mo for the infrastructure.

---

## 9. Disaster recovery

### Lost a tenant deploy

```sh
# Re-trigger the workflow; sync pulls latest from Payload, rebuilds, redeploys.
gh workflow run tenant-deploy.yml -f tenant_slug=<slug>
```

### Lost the Payload host

```sh
# 1. Spin up a new Payload host (Railway/Fly/etc.).
# 2. Point it at the same DATABASE_URI + R2.
# 3. Update WEBHOOK_URL on tenants that point at Payload (if any do).
# 4. Update PAYLOAD_URL in GitHub Actions secrets.
# That's it — no data was on the host itself.
```

Payload is **stateless** — it's just a process that reads/writes to Postgres + R2. Recreating it is fast.

### Lost the database

```sh
# Restore from Neon point-in-time recovery (PITR is built into the free tier; up to 7 days).
# Neon dashboard -> Branches -> Restore to point in time -> pick timestamp -> creates a new branch
# -> point DATABASE_URI at the new branch's connection string.
```

### Lost R2 media

R2 has no built-in versioning. Mitigation:
- Keep your migration sources (the original WordPress export, etc.) so you can re-upload.
- Or set up a daily sync to a different bucket / S3 with `rclone`.

### Lost git history

Git is decentralized. As long as one developer has a clone, you have the code. Mirror to a second remote (e.g. GitLab) for paranoia.

---

## 10. Common operational tasks

### Add a new admin user

Admin → Users → **Create New** → email, password, tenants, role. The user receives login at the admin URL. Best practice: roles = `editor` (scoped to one or more tenants) or `super-admin` (sees all).

### Disable webhooks for one tenant (e.g. while doing bulk edits)

Admin → Tenants → that tenant → **Deploy tab** → uncheck **Webhook Enabled** → Save. Now content changes for that tenant won't trigger rebuilds. Re-enable when done.

### Force a rebuild without a content change

```sh
gh workflow run tenant-deploy.yml -f tenant_slug=<slug>
```

### Inspect what the deploy actually did

GitHub Actions → workflow run → see each step's logs. The `tenant-cli sync` step prints exactly which collections it pulled and how many rows; the build step prints page counts.

### Migrate a tenant's domain

1. Admin → Tenants → tenant → change **Domain** → Save (this triggers a webhook + rebuild).
2. Cloudflare dashboard → Worker for that tenant → **Triggers → Custom Domains** → remove old domain, add new.
3. Update DNS at the new domain's registrar to point to Cloudflare.

### Delete a tenant

1. Admin → Tenants → tenant → **Delete**. (This soft-deletes; content rows remain but become orphaned.)
2. For a hard cleanup: `DELETE FROM tenants WHERE slug = '<slug>';` cascades through Postgres (the foreign keys are `ON DELETE CASCADE`).
3. Remove the Cloudflare Worker: dashboard → Worker → **Settings → Delete**.
4. Remove the folder: `rm -rf apps/sites/<slug>` and commit.

---

## 11. Where things live (file map)

```
astropayload/
├── apps/
│   ├── payload/              # The shared CMS
│   │   ├── src/
│   │   │   ├── collections/  # All collection schemas
│   │   │   ├── hooks/        # afterChange webhook notifier
│   │   │   ├── access/       # Tenant access control rules
│   │   │   └── payload.config.ts
│   │   ├── scripts/          # One-off migration scripts
│   │   └── .env              # Production secrets (gitignored)
│   │
│   ├── webhook/              # Cloudflare Worker, dispatches deploys
│   │   ├── src/index.ts
│   │   └── wrangler.jsonc
│   │
│   └── sites/                # One folder per tenant
│       ├── keukenfaqs/
│       │   ├── src/          # Astro app code
│       │   ├── tenant.config.json   # generated by sync
│       │   ├── astro.config.mjs
│       │   └── wrangler.jsonc       # Cloudflare Worker config
│       └── <other-tenants>/
│
├── packages/
│   ├── core/                 # Shared types + theme/JSON-LD helpers
│   ├── payload-sdk/          # Typed Payload REST client + sync logic
│   └── tenant-cli/           # `pnpm tenant-cli` command
│
├── .github/
│   └── workflows/
│       └── tenant-deploy.yml # The single deploy workflow
│
└── docs/
    ├── COMMANDS.md           # Per-command reference
    ├── PRODUCTION.md         # This file
    └── ONBOARDING.md         # Short onboarding cheatsheet
```

---

## 12. Cheatsheet: the 5 most common production tasks

```sh
# 1. Add a tenant
export PAYLOAD_URL=https://cms.yourcompany.com
export PAYLOAD_API_KEY=<ci-user-key>
pnpm tenant-cli create --slug <slug> --domain <domain>

# 2. Push a content/code update for one tenant (manual; CI normally handles it)
gh workflow run tenant-deploy.yml -f tenant_slug=<slug>

# 3. Push a code update across all tenants (after a shared package change)
for slug in $(curl -s -H "Authorization: users API-Key $PAYLOAD_API_KEY" \
  "$PAYLOAD_URL/api/tenants?limit=1000" | jq -r '.docs[].slug'); do
  gh workflow run tenant-deploy.yml -f tenant_slug=$slug
done

# 4. Roll back a tenant
# In Cloudflare dashboard: Worker -> Deployments -> Rollback to previous

# 5. Generate a fresh API key for a CI user
# Admin -> Users -> ci-user -> "Enable API Key" -> Save -> copy
```

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **Tenant** | One end-customer site (one domain, one set of content). |
| **Slug** | The tenant's lowercase identifier used in URLs, folder names, Worker names. |
| **Collection** | A Payload schema (Blog Posts, Pages, etc.). Each row in a collection has a `tenant_id`. |
| **Multi-tenant plugin** | `@payloadcms/plugin-multi-tenant` — scopes every API query to the active tenant. |
| **Sync** | Pulling a tenant's content from Payload into the tenant's git folder (Markdown/JSON files). Done at build time, not at request time. |
| **Hybrid output (Astro)** | Mostly prerendered static pages, with `export const prerender = false` per route for SSR. Deployed as one Cloudflare Worker. |
| **`workflow_dispatch`** | GitHub Actions trigger that runs a workflow on demand with input parameters. |
| **Wrangler** | Cloudflare's CLI for managing Workers/Pages/R2/KV. |
| **Worker** | A Cloudflare serverless function. Each tenant gets its own. |
| **Concurrency group** | GitHub Actions feature that collapses parallel runs sharing a key. We key by tenant slug. |

---

## See also

- [COMMANDS.md](./COMMANDS.md) — every command with use case and example
- [ONBOARDING.md](./ONBOARDING.md) — short cheatsheet for the new-tenant flow
- [Payload docs](https://payloadcms.com/docs)
- [Astro docs](https://docs.astro.build)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
