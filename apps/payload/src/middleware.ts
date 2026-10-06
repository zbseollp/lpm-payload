import { NextResponse } from 'next/server'

import type { NextRequest } from 'next/server'

import { isPayloadApiDebug, payloadLog } from './lib/payloadLogger'

/**
 * Recover Payload cookie-based auth when the browser (or something between it
 * and us) strips `Origin` and `Sec-Fetch-Site` from outbound fetches.
 *
 * Payload's `extractJWT` only honors a `payload-token` cookie if either:
 *   1. `Origin` is present AND matches `payload.config.csrf`, OR
 *   2. `Origin` is missing AND `Sec-Fetch-Site` is `same-origin|same-site|none`.
 *
 * Some Chrome extensions (and certain enterprise MITM proxies) rewrite outgoing
 * fetches in a way that drops BOTH headers, even on plain same-origin GETs. The
 * cookie then becomes unusable and every admin call returns 401, even though
 * the same JWT works fine via `Authorization: JWT ...`.
 *
 * This middleware synthesises an `Origin` header from `Referer` — but ONLY when
 * `Referer`'s origin is already in our allow-list. That preserves CSRF safety:
 *
 *   - Browsers set `Referer` themselves; JS on a malicious cross-site page
 *     cannot forge it to point at our admin.
 *   - We never widen the allow-list — we only re-derive what the browser would
 *     have sent if it weren't being interfered with.
 *   - If `Origin` IS present, we leave it untouched, so legitimate cross-origin
 *     enforcement still works.
 */

const ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const set = new Set<string>()
  const server = process.env.PAYLOAD_PUBLIC_SERVER_URL?.replace(/\/+$/, '')
  if (server) set.add(server)
  for (const raw of process.env.PAYLOAD_ALLOWED_ORIGINS?.split(',') ?? []) {
    const trimmed = raw.trim().replace(/\/+$/, '')
    if (trimmed) set.add(trimmed)
  }
  if (process.env.NODE_ENV !== 'production') {
    set.add('http://localhost:3000')
  }
  return set
})()

function allowedOriginsFor(req: NextRequest): Set<string> {
  const set = new Set(ALLOWED_ORIGINS)
  const host = req.headers.get('host')
  if (host) {
    const proto = req.nextUrl.protocol.replace(':', '')
    set.add(`${proto}://${host}`)
  }
  return set
}

/**
 * payload-totp reads `x-pathname` via `headers()` in server components — that
 * only sees **request** headers. Setting it on the response alone makes every
 * admin route look like `/`, which breaks redirects to /admin/setup-totp.
 */
function nextWithPathname(req: NextRequest, requestHeaders?: Headers): NextResponse {
  const headers = requestHeaders ?? new Headers(req.headers)
  headers.set('x-pathname', req.nextUrl.pathname)
  return NextResponse.next({ request: { headers } })
}

export function middleware(req: NextRequest): NextResponse {
  const allowed = allowedOriginsFor(req)

  const isMutatingApi =
    req.nextUrl.pathname.startsWith('/api/') &&
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    req.method !== 'OPTIONS'

  const origin = req.headers.get('origin')
  if (origin && !allowed.has(origin) && isMutatingApi && isPayloadApiDebug()) {
    payloadLog.warn('middleware.origin_rejected', {
      path: req.nextUrl.pathname,
      method: req.method,
      origin,
      allowed: [...allowed],
    })
  }

  if (origin && allowed.has(origin)) return nextWithPathname(req)

  let synthOrigin: string | null = null

  const referer = req.headers.get('referer')
  if (referer) {
    try {
      const url = new URL(referer)
      const refOrigin = `${url.protocol}//${url.host}`
      if (allowed.has(refOrigin)) synthOrigin = refOrigin
    } catch {
      // ignore invalid referer
    }
  }

  if (!synthOrigin) {
    const host = req.headers.get('host')
    if (host) {
      const proto = req.nextUrl.protocol.replace(':', '')
      const hostOrigin = `${proto}://${host}`
      if (allowed.has(hostOrigin)) synthOrigin = hostOrigin
    }
  }

  if (!synthOrigin) {
    if (isMutatingApi && isPayloadApiDebug() && !origin) {
      payloadLog.warn('middleware.no_origin', {
        path: req.nextUrl.pathname,
        method: req.method,
        host: req.headers.get('host'),
        referer: req.headers.get('referer'),
      })
    }
    return nextWithPathname(req)
  }

  if (isMutatingApi && isPayloadApiDebug()) {
    payloadLog.info('middleware.origin_synthesized', {
      path: req.nextUrl.pathname,
      method: req.method,
      synthOrigin,
    })
  }

  const forwardedHeaders = new Headers(req.headers)
  forwardedHeaders.set('origin', synthOrigin)

  return nextWithPathname(req, forwardedHeaders)
}

/**
 * Match both:
 *   - /api/*   (REST endpoints — populate-tenant-options, users/login, users/me, …)
 *   - /admin/* (Next.js server components inside the admin panel also run
 *     Payload's auth check via extractJWT; without Origin they bounce
 *     authenticated users straight back to /admin/login.)
 */
export const config = {
  matcher: ['/api/:path*', '/admin/:path*'],
}
