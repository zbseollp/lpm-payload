import type { Endpoint, PayloadRequest } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function extractId(req: PayloadRequest): string | null {
  const params = (req as unknown as { routeParams?: Record<string, unknown> }).routeParams
  const id = params?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function requireSuperAdmin(req: PayloadRequest): Response | null {
  if (!req.user) return json({ ok: false, message: 'You must be logged in.' }, 401)
  if (!isSuperAdmin(req.user)) {
    return json({ ok: false, message: 'Only super-admins can manage Cloudflare credentials.' }, 403)
  }
  return null
}

/** POST /api/cloudflare-credentials/:id/clear-token */
export const clearCloudflareCredentialTokenEndpoint: Endpoint = {
  path: '/:id/clear-token',
  method: 'post',
  handler: async (req) => {
    const denied = requireSuperAdmin(req)
    if (denied) return denied

    const id = extractId(req)
    if (!id) return json({ ok: false, message: 'Missing credential id.' }, 400)

    try {
      await req.payload.update({
        collection: 'cloudflare-credentials',
        id,
        data: {
          apiTokenEncrypted: null,
          apiTokenLast4: null,
          lastValidatedAt: null,
          lastValidationError: null,
        } as never,
        overrideAccess: true,
      })
    } catch {
      return json({ ok: false, message: 'Credential not found.' }, 404)
    }

    return json({ ok: true, message: 'Stored API token removed. Paste a new token and save.' })
  },
}
