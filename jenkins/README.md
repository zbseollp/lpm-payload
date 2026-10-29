# Jenkins CI for astropayload

Move all tenant pipelines off GitHub Actions onto your Jenkins VPS. Payload admin chooses the backend under **Globals → Platform settings → CI provider**.

**→ Full guide: [GITHUB-TO-JENKINS.md](./GITHUB-TO-JENKINS.md)** — converting GitHub Actions YAML to Jenkinsfiles, triggered jobs, and cron schedulers.

## Architecture

```
Payload admin (Publish / Deploy / Import)
    → dispatchCiJob() → Jenkins buildWithParameters
    → jenkins/scripts/*.sh (same steps as GitHub Actions)
    → report-deploy → Payload tenant status
```

Scheduled publish runs on **Jenkins cron** (not on the Payload VPS):

```
Jenkins: scheduled-publish (hourly)
    → POST /api/scheduled-publish/run on Payload CMS
    → promotes due posts → triggers tenant-deploy per tenant
```

## 1. Payload server `.env`

```env
CI_PROVIDER=jenkins

JENKINS_URL=https://jenkins.yourdomain.com
JENKINS_USER=your-api-user
JENKINS_API_TOKEN=your-api-token

# Optional job name overrides (defaults match job key)
JENKINS_JOB_DEPLOY=tenant-deploy
JENKINS_JOB_IMPORT=tenant-import-blog
JENKINS_JOB_SETUP=tenant-repo-setup
JENKINS_JOB_SCAFFOLD=tenant-scaffold

# Platform repo checkout (Jenkins agents)
GITHUB_OWNER=yourorg
GITHUB_REPO=astropayload
PLATFORM_GIT_BRANCH=jenkins
```

Also set existing vars: `DEPLOY_REPORT_TOKEN`, `PAYLOAD_URL`, `EXTERNAL_REPO_GITHUB_TOKEN`, etc.

## 2. Admin UI

1. Log in as super-admin
2. **Globals → Platform settings**
3. Set **CI provider** → **Jenkins**
4. Save

If the admin shows `relation "platform_settings" does not exist`, run on the Payload VPS:

```sh
cd /var/www/astropayload
psql "$DATABASE_URI" -f apps/payload/scripts/sync-prod-schema.sql
pm2 restart payload
```

(Or rely on `CI_PROVIDER=jenkins` in `.env` until the global is migrated.)

## 3. Create Jenkins jobs

Create **Pipeline** jobs pointing at this repo (branch `jenkins`):

| Job name | Jenkinsfile |
|----------|-------------|
| `tenant-deploy` | `jenkins/Jenkinsfile.tenant-deploy` |
| `tenant-import-blog` | `jenkins/Jenkinsfile.tenant-import-blog` |
| `tenant-scaffold` | `jenkins/Jenkinsfile.tenant-scaffold` |
| `tenant-repo-setup` | `jenkins/Jenkinsfile.tenant-repo-setup` |
| `scheduled-publish` | `jenkins/Jenkinsfile.scheduled-publish` |

Enable **This project is parameterized** (Jenkins reads parameters from the Jenkinsfile).

For `scheduled-publish`, the Jenkinsfile includes `cron('0 * * * *')` — enable **Build periodically** or use Pipeline triggers.

## Store secrets in Cloudflare (not on the VPS)

Deploy [apps/secrets](../apps/secrets/README.md), then on **each** machine keep only:

```
LPM_SECRETS_URL=https://lpm-payload-secrets.<account>.workers.dev
LPM_SECRETS_TOKEN=<SECRETS_ACCESS_TOKEN>
```

GitHub Actions uses the same Worker with `role=github` (see `.github/scripts/load-cloudflare-secrets.sh`). Jobs **do not require** the old `credentials('astropayload-…')` bindings once the Worker URL is set. At the start of each script they run `jenkins/scripts/load-cloudflare-secrets.sh`, which `GET`s:

`LPM_SECRETS_URL/v1/secrets?role=jenkins`

with `Authorization: Bearer LPM_SECRETS_TOKEN`. The Worker also checks the Jenkins VPS IP (`ALLOWED_IPS`).

Better: store the token as Secret text ID `lpm-secrets-token` (optional). `jenkins/withJobSecrets.groovy` binds it when present.

## 4. Jenkins credentials (IDs must match Jenkinsfiles)

Create these under **Manage Jenkins → Credentials** as **Secret text** (unless noted):

| Credential ID | Required | Value |
|---------------|----------|--------|
| `astropayload-payload-url` | yes | `https://payload.10beste.com` |
| `astropayload-deploy-report-token` | yes | Same as Payload `DEPLOY_REPORT_TOKEN` |
| `astropayload-external-repo-github-token` | yes (external deploy) | Fallback PAT for client repos |
| `astropayload-platform-github-token` | yes | GitHub PAT — read for clone, write for scaffold PRs |
| `astropayload-cloudflare-api-token` | yes (deploy) | Wrangler deploy |
| `astropayload-cloudflare-account-id` | yes (deploy) | Cloudflare account |

Optional: set global env `PAYLOAD_API_KEY` on Jenkins if you prefer API key auth over `DEPLOY_REPORT_TOKEN` (not required when the report token is set).

### Per-tenant client build env (Astro `import.meta.env` / `.env`)

External sites (e.g. **10reviews**) often need keys like `PUBLIC_HCAPTCHA_SITEKEY`, `HCAPTCHA_SECRET`, `WEB3FORMS_API_KEY`. GitHub client-repo secrets are **not** visible to Jenkins. Provide them in one of these ways (first match wins):

1. **Jenkins Secret file** credential ID: `astropayload-site-env-<tenant_slug>`  
   Contents = dotenv (`KEY=value` lines). See [client-env.example.env](./client-env.example.env).  
   Example id for 10reviews: `astropayload-site-env-10reviews`
2. **Agent file drop**: `$JENKINS_HOME/astropayload-client-env/<tenant_slug>.env`  
   (override directory with Jenkins env `ASTROPAYLOAD_CLIENT_ENV_DIR`)

On deploy, `tenant-deploy.sh` loads that file and writes `site/.env` before `astro build` (keys are logged by **name only**).

Optional: set global env on Jenkins (only needed if scripts run outside Pipeline-from-SCM):

| Name | Example |
|------|---------|
| `GITHUB_OWNER` | `zbseollp` |
| `GITHUB_REPO` | `astropayload` |
| `PLATFORM_GIT_BRANCH` | `jenkins` |

When the job uses **Pipeline script from SCM**, Jenkins already checks out the repo — no extra clone env vars required.

## 5. Jenkins agent requirements

- **git** and **curl** (Node/pnpm are installed automatically by `jenkins/scripts/setup-node-pnpm.sh` on first run)
- Network access to GitHub, nodejs.org, Payload CMS, and Cloudflare
- Optional: preinstall Node 22 + pnpm 9 to skip the download step

## 6. Client repo tokens

Unchanged from GitHub Actions:

1. Tenant **GitHub credential** in Payload (per tenant)
2. Else `EXTERNAL_REPO_GITHUB_TOKEN`
3. Jenkins calls `GET /api/ci/github-token?tenant=...` via `jenkins/scripts/resolve-client-github-token.sh`

## 7. Disable GitHub Actions (optional)

After Jenkins is verified, disable or remove `.github/workflows/*.yml` triggers on the branch you deploy from.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Jenkins is not configured` | Set `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` on Payload VPS |
| 403 on client checkout | Link tenant GitHub credential or set `EXTERNAL_REPO_GITHUB_TOKEN` |
| Job not found | Match `JENKINS_JOB_*` env to Jenkins job names |
| `tenant-deploy is not parameterized` | Run each Pipeline job **Build Now** once so Jenkins loads parameters from the Jenkinsfile; then **Build with Parameters** appears and Payload can trigger deploys |
| `github.com/https://github.com/...` on clone | `github_repo` must be `owner/repo` (Payload sends this automatically); if testing manually, use `Vivekworks114/cosmeticaspecialisten` not the full URL |
| Wrangler tries `astro add cloudflare` in CI | Client repo needs `wrangler.toml`, `@astrojs/cloudflare`, and `wrangler` devDependency committed — CI runs `build` then `wrangler deploy` only |
| `JavaScript heap out of memory` during `astro build` | `tenant-deploy.sh` sets `NODE_OPTIONS=--max-old-space-size=8192` before build; ensure the Jenkins agent has ≥10GB RAM or lower `ASTRO_BUILD_HEAP_MB` |
| Contact form / `import.meta.env` empty after deploy | Add Secret file `astropayload-site-env-<slug>` (or `$JENKINS_HOME/astropayload-client-env/<slug>.env`) with the site’s dotenv keys |
| `ERROR: astropayload-…` | Create the missing **Secret text** credential ID from section 4 (exact spelling) |
| Crumb / CSRF errors | `jenkinsDispatch.ts` sends Jenkins crumb automatically |
