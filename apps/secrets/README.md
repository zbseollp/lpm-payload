# Cloudflare secrets for Payload and GitHub Actions

Keep **one** bootstrap token on each machine. Store the real secrets in Cloudflare (Workers → **lpm-payload-secrets** → Settings → Variables and Secrets). Rotate a value there; the next Payload restart / GitHub Actions run picks it up.

You still need locally:

| Machine | Keep locally |
|---|---|
| Payload | `LPM_SECRETS_URL`, `LPM_SECRETS_TOKEN` |
| GitHub Actions | repo secrets `LPM_SECRETS_URL`, `LPM_SECRETS_TOKEN` only |

Do **not** put `DATABASE_URI`, GitHub PATs, or Cloudflare API tokens in `.env` / GitHub Actions secrets once this Worker is live.

## Deploy the Worker

```sh
cd apps/secrets
pnpm deploy
# note the URL, e.g. https://lpm-payload-secrets.<account>.workers.dev

# Bootstrap token (also stored on Payload)
openssl rand -hex 32
pnpm wrangler secret put SECRETS_ACCESS_TOKEN

# Recommended: a second token just for GitHub Actions (role=github)
openssl rand -hex 32
pnpm wrangler secret put SECRETS_GITHUB_TOKEN

# Payload keys (skip any you do not use)
pnpm wrangler secret put PAYLOAD_PUBLIC_SERVER_URL
pnpm wrangler secret put PAYLOAD_COOKIE_SECURE
pnpm wrangler secret put PAYLOAD_INTERNAL_URL
pnpm wrangler secret put PAYLOAD_API_KEY
pnpm wrangler secret put PAYLOAD_SDK_TIMEOUT_MS
pnpm wrangler secret put DATABASE_URI
pnpm wrangler secret put R2_ACCOUNT_ID
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
pnpm wrangler secret put R2_BUCKET
pnpm wrangler secret put R2_PUBLIC_URL
pnpm wrangler secret put EXTERNAL_REPO_GITHUB_TOKEN
pnpm wrangler secret put GITHUB_TOKEN
pnpm wrangler secret put GITHUB_OWNER
pnpm wrangler secret put GITHUB_REPO
pnpm wrangler secret put GITHUB_BRANCH
pnpm wrangler secret put PLATFORM_GIT_BRANCH
pnpm wrangler secret put PAYLOAD_SECRET
pnpm wrangler secret put PAYLOAD_ALLOWED_ORIGINS
pnpm wrangler secret put PAYLOAD_DEBUG_AUTH
pnpm wrangler secret put PAYLOAD_DEBUG_API
pnpm wrangler secret put NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
pnpm wrangler secret put DEPLOY_REPORT_TOKEN
pnpm wrangler secret put PAYLOAD_TOTP_ISSUER
pnpm wrangler secret put CREDENTIALS_ENCRYPTION_KEY
```

Or paste `worker.dashboard.js` into the Cloudflare dashboard Worker editor and deploy.

Non-secret config (`GITHUB_OWNER`, `GITHUB_REPO`, `PAYLOAD_TOTP_ISSUER`) can be **plain variables** in the same Worker settings instead of secrets.

## Allow only the Payload VPS IP

`/v1/secrets?role=payload` requires **both** the bearer token **and** a matching source IP (`CF-Connecting-IP`). `/health` stays public and does not return secrets.

1. Find the VPS public IP (`curl -4 ifconfig.me` on Payload).
2. Set Worker **Settings → Variables** (plain text, not a secret):

```
ALLOWED_IPS=203.0.113.10
```

Use the real IPs. IPv4 CIDR is allowed (`203.0.113.0/24`). Then `pnpm deploy` (or save in the dashboard).

A stolen `LPM_SECRETS_TOKEN` from another network gets **403** on the payload role. The error JSON includes `ip` so you can add the address you actually egress from (NAT / extra NIC).

Do not put `ALLOWED_IPS` in git with production addresses — override in the Cloudflare dashboard after deploy.

## GitHub Actions (no IP allowlist)

GitHub-hosted runners have ephemeral IPs, so `role=github` is **token-only**. Workflows call `.github/scripts/load-cloudflare-secrets.sh`, which `GET`s:

`LPM_SECRETS_URL/v1/secrets?role=github`

with `Authorization: Bearer LPM_SECRETS_TOKEN` and writes values into `GITHUB_ENV` (masked). Prefer `SECRETS_GITHUB_TOKEN` on the Worker so a leaked VPS token cannot fetch the GitHub role.

Repo secrets to keep:

| Secret | Value |
|---|---|
| `LPM_SECRETS_URL` | `https://lpm-payload-secrets.<account>.workers.dev` |
| `LPM_SECRETS_TOKEN` | same as Worker `SECRETS_GITHUB_TOKEN` (or `SECRETS_ACCESS_TOKEN` if you did not set a GitHub token) |

Legacy GitHub Actions secrets (`PAYLOAD_URL`, `PAYLOAD_API_KEY`, …) still work as a fallback when `LPM_SECRETS_URL` is unset.

## Payload VPS `.env`

```env
LPM_SECRETS_URL=https://lpm-payload-secrets.<account>.workers.dev
LPM_SECRETS_TOKEN=<same as SECRETS_ACCESS_TOKEN>
```

Restart Payload after the first setup. Later rotations: change the Worker secret, then click **Reload env** in admin (super-admin), or `pm2 reload payload`.

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is needed at **`pnpm build`**. Either leave it in `.env` for builds, or wrap: fetch secrets, then build.

## Rotate

1. Cloudflare dashboard → Worker → Secrets → edit the one key
   or `pnpm wrangler secret put KEY`
2. Payload: Admin → **Reload env**, or `pm2 reload payload`
3. GitHub Actions: next workflow run

Rotate `SECRETS_ACCESS_TOKEN` / `SECRETS_GITHUB_TOKEN` by putting a new value in Cloudflare, then update Payload and the GitHub repo secret.
