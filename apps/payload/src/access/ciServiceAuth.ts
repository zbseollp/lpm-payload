import { timingSafeEqual } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { isSuperAdmin } from './isSuperAdmin'

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * GitHub Actions and other CI may authenticate with a super-admin API key or
 * `x-deploy-report-token` (DEPLOY_REPORT_TOKEN on the CMS server).
 *
 * Token compare is timing-safe — required because this endpoint returns secrets
 * (GitHub PAT / Cloudflare API token) and the platform repo may be public.
 */
export function isCiServiceAuthorized(req: PayloadRequest): boolean {
  if (isSuperAdmin(req.user)) return true

  const expected = process.env.DEPLOY_REPORT_TOKEN?.trim()
  if (!expected) return false

  const header = req.headers?.get?.('x-deploy-report-token')?.trim() ?? null
  if (!header) return false
  return safeEqualString(header, expected)
}
