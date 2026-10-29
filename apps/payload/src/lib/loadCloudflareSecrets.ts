const ALLOWED_KEYS = new Set([
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

function secretsEndpoint(): { base: string; token: string } | null {
  const base = (process.env.LPM_SECRETS_URL || process.env.ASTROPAYLOAD_SECRETS_URL)?.trim().replace(/\/+$/, '')
  const token = (process.env.LPM_SECRETS_TOKEN || process.env.ASTROPAYLOAD_SECRETS_TOKEN)?.trim()
  if (!base) return null
  if (!token) {
    throw new Error('LPM_SECRETS_URL is set but LPM_SECRETS_TOKEN is missing.')
  }
  return { base, token }
}

/**
 * Pull secrets from the lpm-payload-secrets Worker into process.env.
 * No-op unless LPM_SECRETS_URL (or ASTROPAYLOAD_SECRETS_URL) is set.
 */
export async function applyCloudflareSecrets(): Promise<void> {
  const endpoint = secretsEndpoint()
  if (!endpoint) return

  const res = await fetch(`${endpoint.base}/v1/secrets?role=payload`, {
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Cloudflare secrets worker returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const body = (await res.json()) as { ok?: boolean; values?: Record<string, string> }
  if (!body.ok || !body.values || typeof body.values !== 'object') {
    throw new Error('Cloudflare secrets worker returned an invalid payload.')
  }

  const applied: string[] = []
  for (const [key, value] of Object.entries(body.values)) {
    if (!ALLOWED_KEYS.has(key)) continue
    if (typeof value !== 'string' || !value) continue
    process.env[key] = value
    applied.push(key)
  }

  console.info(`[lpm-payload] loaded ${applied.length} secret(s) from Cloudflare (${applied.join(', ')})`)
}
