# @astropayload/payload

Single Payload v3 CMS that powers every tenant site. **Blog-only** — one shared schema for all tenants.

## Stack

- **Payload v3** on Next.js 15 (App Router)
- **Postgres** via `@payloadcms/db-postgres` (Neon recommended for prod)
- **Cloudflare R2** via `@payloadcms/storage-s3` (with `tenants/<slug>/` prefix per upload)
- **Lexical** rich text editor
- **`@payloadcms/plugin-multi-tenant`** scoping blog + media by tenant

## Setup

```sh
cp .env.example .env
# fill in DATABASE_URI, PAYLOAD_SECRET, R2_* values

pnpm install
pnpm dev                       # http://localhost:3000/admin
pnpm payload generate:types    # regenerate src/payload-types.ts
```

## Collections

| Slug          | Scope  | Purpose |
| ------------- | ------ | ------- |
| `tenants`     | global | One row per site: domain, branding, SEO, analytics |
| `users`       | global | Admin users (roles + tenant access); TOTP 2FA required for admin login |
| `blog-posts`  | tenant | Articles (title, slug, body, categories, tags, SEO) |
| `media`       | tenant | Images for blog hero / OG (R2) |

Static pages (Home, Contact, About) live in each tenant's **Astro app** (`apps/sites/<slug>/src/pages/`), not in Payload.

## Publishing to the live site

Saves update Postgres only. Editors click **Publish content to live site** to run `tenant-deploy.yml` (sync blog → build → deploy).

See [docs/PRODUCTION.md](../../docs/PRODUCTION.md) and [apps/webhook/README.md](../webhook/README.md).

## WordPress import

```sh
pnpm migrate:wxr -- --wxr ./export.xml --slug my-site --domain my-site.com
```

Imports **posts only**. WP pages are skipped (build those as Astro routes or hardcoded pages).
