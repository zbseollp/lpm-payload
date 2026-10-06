# Onboarding a new tenant

Four paths, depending on where the site code and content live.

## 0. Prerequisites (one-time)

```sh
pnpm install
cp apps/payload/.env.example apps/payload/.env
# fill in: DATABASE_URI, PAYLOAD_SECRET, R2_*, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
pnpm --filter @astropayload/payload dev
# create super-admin at http://localhost:3000/admin
# on first login you will be prompted to set up 2FA (authenticator app)
# enable API key on your user row
export PAYLOAD_URL=http://localhost:3000
export PAYLOAD_API_KEY=<your-api-key>
```

Platform GitHub repo secrets (for CI): `PAYLOAD_URL`, `PAYLOAD_API_KEY`, `GITHUB_TOKEN`, `CLOUDFLARE_*`, optional `DEPLOY_REPORT_TOKEN`.

---

## A. Brand-new tenant (monorepo site)

Site code lives in **this** repo under `apps/sites/<slug>/`.

```sh
pnpm tenant-cli create --slug new-site --domain new-site.com --name "New Site"
# Add blog posts in Payload admin
TENANT=new-site pnpm --filter @astropayload/site-new-site sync:content   # local preview
TENANT=new-site pnpm --filter @astropayload/site-new-site dev
```

**Publish:** Tenants → **Publish content**, or Blog list → **Publish content to live site**.  
Deploy target shown in admin: **Monorepo · apps/sites/new-site**.

---

## B. Migrate from WordPress (WXR — blog posts only)

```sh
pnpm tenant-cli create --slug new-site --domain new-site.com
pnpm --filter @astropayload/payload run migrate:wxr \
  --wxr /path/to/wordpress-export.xml \
  --slug new-site \
  --domain new-site.com
TENANT=new-site pnpm --filter @astropayload/site-new-site sync:content
```

WP pages are **not** imported — static pages stay as Astro routes in the site repo.

| Script        | Required flags                                | Optional   |
| ------------- | --------------------------------------------- | ---------- |
| `migrate:wxr` | `--wxr <path>` `--slug <slug>` `--domain <d>` | `--limit N` |

---

## C. Client-owned GitHub repo (external site)

Use when each client has their **own** Astro repo. Payload remains the **blog** source of truth; publish syncs markdown at **build time** (CI does not commit synced files back by default).

### 1. Create tenant in Payload

- **Slug** must match `TENANT` / Wrangler / `astropayload.config.json`.
- **GitHub** tab: set `githubRepo` (`owner/repo`), branch, enable **blog** module, set `blogContentPath` (e.g. `content/blog`), and **blog file extension** (`md` or `mdx`) to match the Astro repo.

### 2. Validate & setup

On the tenant **GitHub** tab (super-admin):

1. **Validate repository** — checks access, branch, `astro.config`, blog folder.
2. **Setup repository (PR)** — opens a PR on the client repo with:
   - `astropayload.config.json`
   - `scripts/sync-content.mjs` (optional local dev)
   - `src/content/blog/` (or your path)
   - `.github/workflows/astropayload-setup-notify.yml`

3. **Merge the PR** on the client repo.

### 3. Mark setup ready (automatic)

After merge, `githubSetupStatus` becomes **ready** via either:

- **Platform poll** — `tenant-repo-setup.yml` waits up to 30 minutes after opening the PR, or
- **Client workflow** — add secrets on the **client** repo:
  - `ASTROPAYLOAD_URL` — your Payload URL
  - `ASTROPAYLOAD_REPORT_TOKEN` — same as platform `DEPLOY_REPORT_TOKEN`

### 4. Seed Payload from existing repo markdown (automatic)

You do **not** need to `git clone` the client repo on the VPS for production. GitHub Actions checks out the repo during deploy.

On the **first publish** (and after **Setup repository** when the setup PR merges), CI runs `auto-import-blog-if-empty`: if the tenant has **zero** blog posts in Payload, markdown from the connected repo is imported into the CMS, then sync + deploy continue.

**GitHub secrets for auto-import:** `PAYLOAD_URL`, `DEPLOY_REPORT_TOKEN` (must match Payload `.env` — recommended), optional super-admin `PAYLOAD_API_KEY`, `EXTERNAL_REPO_GITHUB_TOKEN`, Cloudflare secrets. No Postgres URL in GitHub.

To force a full re-import anytime, use **Import blog from repo (once)** in the tenant GitHub tab (dispatches `tenant-import-blog.yml`), or locally:

```sh
pnpm --filter @astropayload/payload import:blog-from-repo -- \
  --slug new-site --site /path/to/client-repo --blog-path src/content/blog
```

### 5. Editorial workflow

1. Editors write **Blog posts** in Payload (save = CMS only).
2. **Publish content** → `tenant-deploy.yml` with `deploy_mode=external`:
   - Checkout client repo
   - `tenant-cli sync` from platform
   - `build` + `wrangler deploy` in client repo

Admin shows: **External repo · owner/repo (branch)**.

### Client repo requirements

- Astro project with `build` and `deploy` scripts (Wrangler).
- Cloudflare credentials in **platform** GitHub secrets (used during deploy).
- `GITHUB_TOKEN` on platform must read the client repo.

---

## D. Publish content to production

Editors save in Payload, then click **Publish content to live site** (no deploy on every save).

```sh
# CLI (from monorepo root):
pnpm tenant-cli deploy --slug new-site
pnpm tenant-cli deploy --slug new-site --site /path/to/client-repo   # external

# API:
POST /api/tenants/:id/publish
```

Legacy auto-deploy webhook is **off** by default (`webhookEnabled`).

---

## Anatomy of a publish

```
Editor clicks Publish in Payload admin
  -> POST /api/tenants/:id/publish
    -> dispatch tenant-deploy.yml
      -> deploy_mode: monorepo | external
      -> sync blog markdown from Payload (payload-sdk)
      -> astro build
      -> wrangler deploy
      -> POST /api/tenants/report-deploy (status + workers.dev URL)
```

`concurrency: tenant-deploy-${slug}` collapses rapid clicks into one run per tenant.

---

## Tenant CLI reference

```
pnpm tenant-cli create      --slug X --domain D [--name "Display"]
pnpm tenant-cli sync        --slug X [--site path] [--blog-path path]
pnpm tenant-cli import-blog --slug X --site path [--blog-path path]
pnpm tenant-cli migrate     --slug X --domain D [--wxr file.xml]
pnpm tenant-cli deploy      --slug X [--site path] [--blog-path path]
```

| Flag         | Env var           |
| ------------ | ----------------- |
| `--slug`     | `TENANT`          |
| `--url`      | `PAYLOAD_URL`     |
| `--api-key`  | `PAYLOAD_API_KEY` |

---

## What sync writes (blog module)

**Monorepo:**

```
apps/sites/<slug>/
  tenant.config.json
  src/content/blog/<slug>.md
```

**External repo** (path configurable):

```
<client-repo>/
  src/content/blog/<slug>.md    # default; overwritten on publish (clean sync)
```

Static pages (home, contact, etc.) are Astro files in git — **not** synced from Payload.

Custom frontmatter: use **Blog posts → extra** (JSON); merged into markdown on publish.

---

## CI report endpoints

| Endpoint                         | Purpose                          |
| -------------------------------- | -------------------------------- |
| `POST /api/tenants/report-deploy` | Deploy status + workers URL      |
| `POST /api/tenants/report-scaffold` | Monorepo scaffold PR status    |
| `POST /api/tenants/report-github-setup` | External repo setup ready   |

Auth: super-admin API key or header `x-deploy-report-token: $DEPLOY_REPORT_TOKEN`.

```sh
pnpm --filter @astropayload/payload report:github-setup -- --slug X --status ready
```
