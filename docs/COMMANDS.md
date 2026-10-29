# Commands Reference

Every command you'll run in this monorepo, with a *when to use*, *what it does*, *env vars*, *example*, and *common errors* for each. Grouped by area.

Throughout this doc, **`<slug>`** = the tenant slug (lowercase, hyphens, e.g. `keukenfaqs`).

---

## 0. One-time machine setup

### `npm i -g pnpm@9.12.0`
- **When**: Once per machine.
- **Why**: This repo is a pnpm workspaces monorepo; npm/yarn won't resolve `workspace:*` deps.
- **Verify**: `pnpm --version` prints `9.12.0`.

### `ulimit -n 65536`
- **When**: Before running any Astro dev/build that touches large content collections (e.g. keukenfaqs has 2,600+ JSON files).
- **Why**: macOS defaults to 256–4096 file descriptors; chokidar (the dev watcher) needs one per watched file.
- **Make permanent**: `echo 'ulimit -n 65536' >> ~/.zshrc`
- **Symptom of missing this**: `EMFILE: too many open files`

### `pnpm install`
- **When**: After clone, after pulling new deps, after `tenant-cli create` (new workspace package gets added).
- **What**: Installs every workspace's deps into a shared `node_modules` tree.
- **Tip**: Runs in ~1–4 min the first time, ~5–30s on subsequent runs.

---

## 1. Environment files

Every app has an `.env.example` you copy to `.env`.

### Payload CMS
```sh
cp apps/payload/.env.example apps/payload/.env
# Required at minimum:
#   PAYLOAD_SECRET=$(openssl rand -hex 32)
#   DATABASE_URI=postgres://...
# Optional for local dev (R2 + webhook + GitHub fall back to no-ops if blank).
```

### Each tenant Astro app
```sh
cp apps/sites/<slug>/.env.example apps/sites/<slug>/.env
# Required for sync:content:
#   PAYLOAD_URL=http://localhost:3000
#   PAYLOAD_API_KEY=<generate in admin: Users -> your user -> Enable API Key>
#   TENANT=<slug>
```

### Webhook worker
Production-only; configured via `wrangler secret put` (see [PRODUCTION.md](./PRODUCTION.md)).

### Secrets worker
Production-only. Deploy with `cd apps/secrets && pnpm deploy`, then `wrangler secret put` each key (see [apps/secrets/README.md](../apps/secrets/README.md)). GitHub Actions load CI secrets from this Worker via `.github/scripts/load-cloudflare-secrets.sh`.

---

## 2. Payload CMS (`apps/payload`)

### `pnpm payload:dev`
- **When**: Daily development of the CMS or its collections.
- **What**: Runs Next.js dev server on `http://localhost:3000` with HMR. Auto-loads `apps/payload/.env`.
- **Pre-step**: `generate:importmap` runs automatically as `predev` to keep the admin's client component map fresh.
- **Common errors**:
  - `missing secret key` → `PAYLOAD_SECRET` not in `.env`.
  - `connect ECONNREFUSED 127.0.0.1:5432` → Postgres not running.
  - `getFromImportMap: PayloadComponent not found` → run `pnpm payload:importmap` manually and restart.

### `pnpm payload:build`
- **When**: Producing a production-ready Next.js build (for self-hosting or non-Cloudflare deploy).
- **What**: Standard Next.js production build into `apps/payload/.next/`.

### `pnpm payload:start`
- **When**: Running the production build locally to smoke-test before deploying.
- **What**: Serves the output of `payload:build` on port 3000.

### `pnpm payload:types`
- **When**: After adding/modifying a collection. Generates `apps/payload/src/payload-types.ts` with TypeScript types for every collection/field.
- **What**: Replaces the stub `payload-types.ts` with strongly typed `Tenant`, `BlogPost`, `Page`, `Top10`, etc.
- **Tip**: Run it whenever you'd want IntelliSense in scripts that use `payload.find/create/update`.

### `pnpm payload:importmap`
- **When**: After adding/removing a Payload plugin or custom admin component. Run automatically by `predev`/`prebuild` hooks.
- **What**: Regenerates `apps/payload/src/app/(payload)/admin/importMap.js` so client components used by the admin UI are statically importable.

### `pnpm payload <any-script>`
- **What**: Passthrough — `pnpm payload <name>` runs the `<name>` script inside `apps/payload`. So `pnpm payload typecheck` etc.

---

## 3. Migration scripts (one-off WordPress imports)

All migration scripts:
- Use Payload's **Local API** (in-process), so the dev server doesn't need to be running — only Postgres.
- Auto-load `apps/payload/.env`.
- Resolve relative paths against the **directory you invoke from** (via `INIT_CWD`/`PWD`).
- Print structured validation errors (no more `errors: [Object]`).
- Look up the tenant by `--slug` first, fall back to `--domain` second.

### `pnpm --filter @astropayload/payload run migrate:wxr`
- **When**: First-time import of a WordPress site's posts and pages.
- **Flags**:
  - `--wxr <path>` — path to WordPress eXtended RSS (WXR) XML export. Required.
  - `--slug <slug>` — tenant slug. Required.
  - `--domain <domain>` — tenant domain (no protocol). Required. Auto-creates the tenant if missing.
  - `--limit <N>` — only import the first N items. Use for dry runs.
- **What it does**:
  1. Ensures a `tenants` row exists (creates if needed).
  2. Parses every `<item>` in the WXR.
  3. Filters to `wp:status=publish` + `wp:post_type=post|page`.
  4. Converts HTML → Markdown via Turndown.
  5. Wraps Markdown in a minimal Lexical state and writes to `blog-posts` / `pages`.
- **Example**:
  ```sh
  pnpm --filter @astropayload/payload run migrate:wxr \
    --wxr apps/sites/keukenfaqs/migration/wordpress-export.xml \
    --slug keukenfaqs \
    --domain keukenfaqs.nl
  ```

### `pnpm --filter @astropayload/payload run migrate:money-pages`
- **When**: Importing the scraped affiliate/SEO JSON content (top10 roundups, product reviews, business listings).
- **Flags**:
  - `--slug <slug>` — Required.
  - `--scraped-dir <dir>` — directory containing one JSON per page. Required.
  - `--domain <domain>` — optional; required only if the tenant doesn't exist yet.
  - `--limit <N>` — dry-run cap.
- **What**: Routes each JSON by its `page_type` discriminator into `top10s`, `products`, or `businesses` collections.
- **Example**:
  ```sh
  pnpm --filter @astropayload/payload run migrate:money-pages \
    --slug keukenfaqs \
    --scraped-dir apps/sites/keukenfaqs/src/data/money-pages
  ```

### `pnpm --filter @astropayload/payload run migrate:redirects`
- **When**: Preserving SEO for dropped WordPress URLs that should 301 to a sensible target.
- **Flags**:
  - `--slug <slug>` — Required.
  - `--tsv <file>` — TSV with `<full-url>\t<title>` per line. Required.
  - `--target <path>` — destination path everything redirects to, e.g. `/keukenzaken/`. Required.
  - `--domain <domain>` — optional, used to auto-create the tenant.
- **Example**:
  ```sh
  pnpm --filter @astropayload/payload run migrate:redirects \
    --slug keukenfaqs \
    --tsv apps/sites/keukenfaqs/migration/dropped-urls.txt \
    --target /keukenzaken/
  ```

---

## 4. Tenant Astro app (`apps/sites/<slug>`)

Root-level aliases exist for the keukenfaqs site (`pnpm keukenfaqs:*`). For other tenants use the `--filter` form: `pnpm --filter @astropayload/site-<slug> run <script>`.

### `pnpm keukenfaqs:dev` (or `--filter ... run dev`)
- **When**: Local development of pages, layouts, styles, components.
- **What**: Starts Astro dev server on `http://localhost:4321` with HMR.
- **No Payload needed**: Uses whatever is already in `src/content/*`, `src/data/money-pages/*`, and `tenant.config.json`.
- **Common error**: `EMFILE: too many open files` → see [`ulimit -n 65536`](#ulimit--n-65536).

### `pnpm keukenfaqs:sync` (or `--filter ... run sync:content`)
- **When**: Pulling fresh content from Payload into this tenant's local content tree.
- **What**: Hits Payload REST with `?where[tenant][equals]=<slug>` for every collection. Writes:
  - `src/content/blog/<slug>.md` — one Markdown file per blog post.
  - `src/content/pages/<slug>.md` — one Markdown file per page.
  - `src/data/money-pages/<slug>.json` — one JSON per money page.
  - `public/_redirects` — Cloudflare-format redirect file.
  - `tenant.config.json` — site identity, theme tokens, navigation, analytics IDs.
- **Required env** (loaded from `apps/sites/<slug>/.env`):
  - `PAYLOAD_URL` — e.g. `http://localhost:3000` (dev) or `https://cms.yourcompany.com` (prod).
  - `PAYLOAD_API_KEY` — generated in admin → Users → "Enable API Key".
  - `TENANT` — the tenant slug to filter by.
- **Common error**: `401 Unauthorized` → API key not enabled or wrong value.

### `pnpm keukenfaqs:build`
- **When**: Producing the production hybrid build for Cloudflare Workers.
- **What**: Runs `astro build` with `NODE_OPTIONS=--max-old-space-size=8192` (8GB heap — required for parsing 2,600+ JSON content entries without OOM).
- **Output**:
  - `dist/client/` — static prerendered HTML + assets (uploaded to Cloudflare Static Assets / R2).
  - `dist/server/` — Cloudflare Worker bundle for SSR routes (`/api/contact` etc.).
- **Time**: ~2–4 minutes for keukenfaqs-sized content.

### `pnpm keukenfaqs:preview`
- **When**: Local sanity-check of a built site.
- **What**: `astro preview` — serves `dist/` on a local port. *Doesn't* emulate the Cloudflare Worker runtime.

### `pnpm --filter @astropayload/site-keukenfaqs run cf-preview`
- **When**: Validating SSR routes / R2 / KV bindings before deploy.
- **What**: Builds, then runs `wrangler dev` (Miniflare = local Cloudflare runtime emulator).

### `pnpm keukenfaqs:deploy`
- **When**: Manually pushing this tenant to Cloudflare Workers production. Normally you'd let CI do it (see [PRODUCTION.md](./PRODUCTION.md)).
- **Prereq**: `wrangler login` once.
- **What**: `pnpm build && wrangler deploy`.

### `pnpm --filter @astropayload/site-<slug> astro <subcommand>`
- **What**: Passthrough to Astro's CLI inside that tenant. Useful for `astro sync` (refresh content collection types), `astro add tailwind`, etc.

---

## 5. Tenant CLI (`packages/tenant-cli`)

Designed to be the *only* tool you need when onboarding a new tenant. All scripts ultimately wrap pnpm-filter calls but with friendlier ergonomics.

> **Note:** For most cases you can skip the CLI entirely — the Payload admin has **"Scaffold tenant code"** and **"Deploy now"** buttons on each Tenant row that dispatch the same workflows via GitHub. See [PRODUCTION.md §3 Option A](./PRODUCTION.md#option-a--dashboard-flow-recommended).

### `pnpm tenant-cli create`
- **When**: Onboarding a brand-new tenant from the terminal. (Same job the **Scaffold tenant code** button does, but local instead of via CI.)
- **Flags**:
  - `--slug <slug>` — required (lowercase, hyphens).
  - `--domain <domain>` — required.
  - `--name "<Display Name>"` — optional, defaults to slug.
  - `--template <path>` — optional, defaults to `apps/sites/keukenfaqs/`.
  - `--locale <locale>` — optional, defaults to `nl-NL`.
  - `--skip-payload-create` — boolean. Skips the Payload row creation step. Used by `tenant-scaffold.yml` in CI, where the row already exists.
- **What it does**:
  1. Copies `apps/sites/keukenfaqs/` (or `--template`) to `apps/sites/<slug>/`, **skipping** content folders, `node_modules`, build artefacts, and the old `tenant.config.json`.
  2. Rewrites `package.json` `name` to `@astropayload/site-<slug>`.
  3. Rewrites `wrangler.jsonc` Worker `name` to `<slug>`.
  4. Writes a fresh `tenant.config.json` stub so `astro dev` works before the first sync.
  5. If `PAYLOAD_URL` + `PAYLOAD_API_KEY` are set, creates the matching `tenants` row in Payload via REST.
- **Example**:
  ```sh
  export PAYLOAD_URL=http://localhost:3000
  export PAYLOAD_API_KEY=<your-api-key>
  pnpm tenant-cli create --slug second-site --domain second-site.com --name "Second Site"
  ```

### `pnpm tenant-cli sync`
- **When**: Same as `pnpm --filter @astropayload/site-<slug> run sync:content`. Slightly nicer ergonomics across tenants.
- **Flags**:
  - `--slug <slug>` — required (or set `TENANT` env var).
  - `--url <payload-url>` — falls back to `PAYLOAD_URL` env.
  - `--api-key <key>` — falls back to `PAYLOAD_API_KEY` env.
  - `--site <path>` — defaults to `apps/sites/<slug>`.

### `pnpm tenant-cli deploy`
- **When**: Single command to sync content, build, and deploy a tenant.
- **What**: Runs `sync` → `build` → `wrangler deploy` for the given slug.

### `pnpm tenant-cli migrate`
- **When**: Convenience wrapper around the WXR + money-pages + redirects migrations.
- **Flags**:
  - `--slug <slug>` — required.
  - `--domain <domain>` — required.
  - `--wxr <file>` — optional.
  - `--scraped <dir>` — optional.

---

## 6. Webhook worker (`apps/webhook`)

The Cloudflare Worker that receives Payload's `afterChange` events and dispatches GitHub Actions workflows.

### `pnpm --filter @astropayload/webhook dev`
- **When**: Locally debugging the worker. Runs Wrangler's local server.

### `pnpm --filter @astropayload/webhook deploy`
- **When**: Shipping the worker to Cloudflare.
- **Prereq**: `wrangler login`, plus `wrangler secret put WEBHOOK_TOKEN` and `wrangler secret put GITHUB_TOKEN` to set production secrets.

### `wrangler secret put <name>`
- **When**: Storing production-only secrets (`WEBHOOK_TOKEN`, `GITHUB_TOKEN`) for the worker.
- **What**: Encrypts and uploads the secret to Cloudflare so the worker can read it via `env.WEBHOOK_TOKEN`.

---

## 7. Workspace-wide tasks (run from repo root)

### `pnpm dev`
- Runs `turbo run dev` across the whole workspace. Currently this starts every tenant and Payload simultaneously. Don't use unless you really want all of them — prefer `pnpm payload:dev` + a specific tenant.

### `pnpm build`
- Runs `turbo run build` across every workspace. Turbo's cache will skip unchanged workspaces. Useful in CI.

### `pnpm typecheck`
- Runs `turbo run typecheck`. Calls each package's `typecheck` script (which is mostly `tsc --noEmit` or `astro check`).

### `pnpm lint`
- Runs each package's `lint` script.

### `pnpm --filter <name> exec <cmd>`
- Run any binary inside a specific workspace package's context. Example: `pnpm --filter @astropayload/payload exec payload generate:types`.

---

## 8. Database utilities

### `pnpm payload:types`
- Already documented above. Regenerates `payload-types.ts` from current Postgres schema + collection configs.

### Direct SQL (`psql`)
- **When**: Inspecting raw data during migration debugging.
- **Example**: `psql $DATABASE_URI -c "SELECT slug, name, domain FROM tenants;"`

### Postgres + Docker (local dev)
```sh
# Start
docker run --name astro-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=astropayload -p 5432:5432 -d postgres:16
# DATABASE_URI=postgres://postgres:dev@localhost:5432/astropayload

# Stop / start later
docker stop astro-pg
docker start astro-pg

# Wipe and start over (DANGEROUS — destroys all data)
docker rm -f astro-pg
```

---

## 9. Cloudflare / Wrangler

### `wrangler login`
- Once per machine. Opens browser to auth with your Cloudflare account.

### `wrangler whoami`
- Sanity check that the right account is active.

### `wrangler deploy` (inside a tenant or `apps/webhook`)
- Pushes the current built bundle to Cloudflare Workers.

### `wrangler tail`
- Real-time logs from a deployed worker. Indispensable when debugging the webhook chain.

### `wrangler secret put <name>`
- Set a secret on the deployed worker.

---

## 10. Git / GitHub

These aren't repo-specific but are part of the standard workflow.

### `git push origin <branch>`
- Pushes to GitHub. Triggers no automatic deploy by itself — deploys are triggered by the Payload → webhook → workflow_dispatch chain. (You **can** manually run the workflow from the GitHub Actions UI for a tenant if needed.)

### `gh workflow run tenant-deploy.yml -f tenant_slug=<slug>`
- Manually trigger the per-tenant build+deploy without needing a content change in Payload. Useful when:
  - Recovering from a failed automated deploy.
  - Forcing a rebuild after manually editing a tenant's Astro code.
  - Verifying that the workflow works for a fresh tenant.
- **Equivalent**: clicking **"Deploy now"** on the tenant row in the Payload admin.

### `gh workflow run tenant-scaffold.yml -f tenant_slug=<slug> -f tenant_domain=<domain> -f tenant_name=<name>`
- Manually trigger the scaffold workflow that opens a PR adding `apps/sites/<slug>/`. The tenant row must already exist in Payload.
- **Equivalent**: clicking **"Scaffold tenant code"** on the tenant row in the Payload admin.

---

## 11. Diagnostic / troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `missing secret key` | `PAYLOAD_SECRET` empty | Set in `apps/payload/.env` |
| `connect ECONNREFUSED 127.0.0.1:5432` | Postgres not running | Start it (`docker start astro-pg` or `brew services start postgresql@16`) |
| `EMFILE: too many open files` | macOS fd limit too low | `ulimit -n 65536` |
| `JavaScript heap out of memory` during build | 2,600+ JSON files | Already handled by `NODE_OPTIONS=--max-old-space-size=8192` in build script |
| `getFromImportMap: PayloadComponent not found` | Stale importMap.js | `pnpm payload:importmap` then restart |
| `Tenant 'X' not found` in migration | Slug case mismatch | Pass `--domain` to use domain fallback, or rename slug to lowercase |
| `ValidationError: The following field is invalid: <X>` | Required field missing/empty | New error printer shows full path — fix the data or relax `required: true` |
| `401 Unauthorized` on sync | API key disabled or wrong | Admin → Users → user → "Enable API Key" → Save → copy value |
| Astro build OOM | More tenants than expected | Increase `--max-old-space-size` in tenant's build script |
| Same content shows for all tenants | Multi-tenant plugin not filtering | Check that the collection has `tenant` field and access control runs `userHasAccessToAllTenants` only for super-admins |

---

## 12. Quick-reference: the 8 most-used commands

```sh
# 1. Run Payload locally
pnpm payload:dev

# 2. Run a tenant Astro app locally
pnpm keukenfaqs:dev

# 3. Pull this tenant's content from Payload
pnpm keukenfaqs:sync

# 4. Build a tenant for production (Cloudflare)
pnpm keukenfaqs:build

# 5. Onboard a brand-new tenant
pnpm tenant-cli create --slug <new> --domain <new>.com

# 6. Migrate a WordPress site into a tenant
pnpm --filter @astropayload/payload run migrate:wxr \
  --wxr ./export.xml --slug <new> --domain <new>.com

# 7. Regenerate Payload's typed client + admin import map
pnpm payload:types && pnpm payload:importmap

# 8. Deploy a tenant manually (CI handles this normally)
pnpm keukenfaqs:deploy
```

For the **production pipeline** (how content edits become live deploys without any of these commands being run manually), see [PRODUCTION.md](./PRODUCTION.md).
