#!/usr/bin/env node
/**
 * Fetch Payload secrets from Cloudflare, then exec the remaining argv
 * (e.g. `next start -p 3000`). No-op if LPM_SECRETS_URL is unset.
 */
const ALLOWED = new Set([
  'PAYLOAD_SECRET',
  'PAYLOAD_PUBLIC_SERVER_URL',
  'PAYLOAD_INTERNAL_URL',
  'PAYLOAD_API_KEY',
  'PAYLOAD_SDK_TIMEOUT_MS',
  'PAYLOAD_COOKIE_SECURE',
  'PAYLOAD_ALLOWED_ORIGINS',
  'PAYLOAD_TOTP_ISSUER',
  'PAYLOAD_DEBUG_API',
  'PAYLOAD_DEBUG_AUTH',
  'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
  'DATABASE_URI',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_BRANCH',
  'PLATFORM_GIT_BRANCH',
  'EXTERNAL_REPO_GITHUB_TOKEN',
  'DEPLOY_REPORT_TOKEN',
  'CREDENTIALS_ENCRYPTION_KEY',
])

async function apply() {
  const base = (process.env.LPM_SECRETS_URL || process.env.ASTROPAYLOAD_SECRETS_URL)?.trim().replace(/\/+$/, '')
  const token = (process.env.LPM_SECRETS_TOKEN || process.env.ASTROPAYLOAD_SECRETS_TOKEN)?.trim()
  if (!base) return
  if (!token) {
    throw new Error('LPM_SECRETS_URL is set but LPM_SECRETS_TOKEN is missing.')
  }
  const res = await fetch(`${base}/v1/secrets?role=payload`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Cloudflare secrets worker returned ${res.status}`)
  }
  const body = await res.json()
  if (!body?.ok || !body.values) {
    throw new Error('Cloudflare secrets worker returned an invalid payload.')
  }
  const names = []
  for (const [key, value] of Object.entries(body.values)) {
    if (!ALLOWED.has(key) || typeof value !== 'string' || !value) continue
    process.env[key] = value
    names.push(key)
  }
  console.info(`[lpm-payload] loaded ${names.length} secret(s) from Cloudflare (${names.join(', ')})`)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/run-with-cloudflare-secrets.mjs <command> [args...]')
  process.exit(1)
}

apply()
  .then(async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env, shell: false })
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      process.exit(code ?? 1)
    })
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
