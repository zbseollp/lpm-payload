import { execFile } from 'node:child_process'

import type { Endpoint, PayloadRequest } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'

const COOLDOWN_MS = 20_000
let lastReloadAt = 0

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function pm2Target(): string {
  return (
    process.env.PM2_APP_NAME?.trim() ||
    process.env.pm_id?.trim() ||
    process.env.name?.trim() ||
    'payload'
  )
}

function schedulePm2Reload(): void {
  const target = pm2Target()
  const bin = process.env.PM2_BIN?.trim() || 'pm2'
  setTimeout(() => {
    execFile(bin, ['reload', target, '--update-env'], { timeout: 20_000 }, (err) => {
      if (err) {
        console.error(`[lpm-payload] pm2 reload ${target} failed (${err.message}); exiting so PM2 autorestart can recover`)
        process.exit(0)
      }
    })
  }, 400)
}

/**
 * Super-admin only. After rotating Worker env vars, the admin **Reload env**
 * button POSTs here so PM2 restarts Payload and instrumentation reloads secrets.
 *
 *   POST /api/ops/reload
 */
export const reloadSecretsEndpoint: Endpoint = {
  path: '/ops/reload',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    if (!isSuperAdmin(req.user)) {
      return json({ ok: false, message: 'Unauthorized. Sign in as super-admin to reload env.' }, 401)
    }

    const now = Date.now()
    if (now - lastReloadAt < COOLDOWN_MS) {
      return json(
        {
          ok: false,
          message: 'Reload already requested. Wait a few seconds.',
          retryAfterSec: Math.ceil((COOLDOWN_MS - (now - lastReloadAt)) / 1000),
        },
        429,
      )
    }
    lastReloadAt = now

    schedulePm2Reload()
    return json(
      {
        ok: true,
        reloading: true,
        process: pm2Target(),
        message: 'PM2 reload scheduled. Payload will fetch Cloudflare secrets on the next boot.',
      },
      202,
    )
  },
}
