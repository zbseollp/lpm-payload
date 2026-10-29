# astropayload

A multi-tenant **blog** platform. **One Payload CMS** manages many sites; **each site is an independent Astro deployment** on Cloudflare Workers that syncs blog posts from Payload at build time.

```
astropayload/
├── apps/
│   ├── payload/              # Single Payload v3 CMS (Postgres + R2)
│   ├── secrets/              # Cloudflare Worker that serves CI/Payload secrets
│   └── sites/
│       └── keukenfaqs/       # First tenant — Astro on Cloudflare Workers
├── packages/
│   ├── core/                 # Shared types + helpers (theme tokens, JSON-LD, ...)
│   ├── payload-sdk/          # Typed REST client + content-sync helpers
│   └── tenant-cli/           # CLI: scaffold tenants, migrate WXR, sync, deploy
├── .github/workflows/        # Per-tenant build + deploy on Payload webhook
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Prerequisites

- Node.js **22.x** (or 20.x)
- pnpm **9.x** (`npm i -g pnpm@9.12.0`)
- A Postgres database (Neon recommended for production)
- A Cloudflare account + R2 bucket (for media)

## Quick start

```sh
pnpm install                  # installs every workspace (~1000 deps)
```

### Run the existing keukenfaqs site (no Payload needed)
The tenant ships with `apps/sites/keukenfaqs/tenant.config.json` plus all its
content collections committed, so you can do this with **zero config**:

```sh
pnpm --filter @astropayload/site-keukenfaqs dev      # → http://localhost:4321
pnpm --filter @astropayload/site-keukenfaqs build    # full hybrid build (~2 min)
```

### Run the full Payload + sync flow

```sh
# 1. Configure apps/payload/.env (DATABASE_URI, PAYLOAD_SECRET, R2 creds...)
cp apps/payload/.env.example apps/payload/.env

# 2. Run Payload CMS locally
pnpm --filter @astropayload/payload dev              # → http://localhost:3000/admin

# 3. Pull this tenant's content slice from Payload
TENANT=keukenfaqs pnpm --filter @astropayload/site-keukenfaqs sync:content

# 4. Run / build the tenant
pnpm --filter @astropayload/site-keukenfaqs dev
```

### Onboard a new tenant

**From the Payload admin (recommended):** Tenants → Create New → Save → click **"Scaffold tenant code"**. A PR is opened on GitHub; merge it. Then click **"Deploy now"**. Both buttons live on the Tenant edit page. Requires `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` in `apps/payload/.env`.

**From the terminal (advanced):**

```sh
# Migrate a WordPress export into Payload as a new tenant
pnpm tenant-cli migrate --wxr ./export.xml --slug new-site --domain new-site.com

# Or: scaffold a brand-new tenant Astro app
pnpm tenant-cli create --slug new-site --domain new-site.com
```

## Documentation

| Doc | What's in it |
|---|---|
| [docs/COMMANDS.md](./docs/COMMANDS.md) | Every command in the monorepo with use case, env vars, examples, and common errors. Start here when you're not sure how to do something. |
| [docs/PRODUCTION.md](./docs/PRODUCTION.md) | A-to-Z production playbook: architecture, one-time setup, adding a new tenant, content/code versioning, the CI/CD pipeline, scaling, rollback, disaster recovery. |
| [docs/ONBOARDING.md](./docs/ONBOARDING.md) | Short cheatsheet for the new-tenant flow. |
| [apps/payload/README.md](./apps/payload/README.md) | Payload-specific notes (collections, hooks, migration scripts). |
| [apps/sites/keukenfaqs/README.md](./apps/sites/keukenfaqs/README.md) | Tenant-app-specific notes (sync, build, deploy). |

## Architecture

- **Payload CMS** (`apps/payload`): Postgres-backed, multi-tenant scoped via `@payloadcms/plugin-multi-tenant`. Media stored in Cloudflare R2.
- **Tenant Astro app** (`apps/sites/<slug>`): Hybrid output (mostly static + a few SSR routes). Build-time `sync:content` pulls only this tenant's data and writes files that the existing `astro:content` collections already understand.
- **Manual publish → CI**: Editors click **Publish content** in Payload; that dispatches `tenant-deploy.yml` for that tenant only (sync + build + Wrangler deploy). Saves do not auto-deploy.
