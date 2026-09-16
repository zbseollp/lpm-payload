import type { Endpoint, PayloadRequest } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'
import { checkCloudflareDomainOnAccount } from '../lib/cloudflareApi'
import {
  resolveCloudflareCredentialsForTenant,
  type TenantCloudflareAuth,
} from '../lib/resolveCloudflareCredentials'

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

async function readConfirmFlag(req: PayloadRequest): Promise<boolean> {
  try {
    const body = (await req.json?.()) as { confirmCreateOnAccount?: unknown } | null
    return body?.confirmCreateOnAccount === true
  } catch {
    return false
  }
}

/**
 * POST /api/tenants/:id/validate-cloudflare
 * Check whether the tenant domain's DNS zone is on the resolved Cloudflare account.
 */
export const validateCloudflareEndpoint: Endpoint = {
  path: '/:id/validate-cloudflare',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return json({ ok: false, message: 'You must be logged in.' }, 401)
    if (!isSuperAdmin(req.user)) {
      return json({ ok: false, message: 'Only super-admins can validate Cloudflare.' }, 403)
    }

    const id = extractId(req)
    if (!id) return json({ ok: false, message: 'Missing tenant id.' }, 400)

    const tenant = (await req.payload.findByID({
      collection: 'tenants',
      id,
      depth: 1,
      overrideAccess: true,
    })) as TenantCloudflareAuth & { id: string | number; domain?: string | null }

    if (!tenant) return json({ ok: false, message: 'Tenant not found.' }, 404)

    const resolved = await resolveCloudflareCredentialsForTenant(req.payload, tenant)
    if (!resolved) {
      return json(
        {
          ok: false,
          needsCredential: true,
          message:
            'No Cloudflare credential. Select one on this tenant, or create a Default credential under Platform → Cloudflare credentials.',
        },
        400,
      )
    }

    const domain = tenant.domain?.trim()
    if (!domain) {
      return json(
        {
          ok: false,
          message: 'Tenant has no domain. Set the site domain first.',
        },
        400,
      )
    }

    const check = await checkCloudflareDomainOnAccount({
      accountId: resolved.accountId,
      apiToken: resolved.apiToken,
      domain,
    })

    const notes = [
      `Account: ${resolved.label} (${resolved.accountId.slice(0, 8)}…)`,
      `Source: ${resolved.source}`,
      `Domain: ${domain}`,
      check.message,
    ]
    if (check.zoneName) notes.push(`Zone: ${check.zoneName}`)
    if (check.zoneStatus) notes.push(`Zone status: ${check.zoneStatus}`)

    if (resolved.source !== 'platform-env' && resolved.credentialId !== 'env') {
      await req.payload.update({
        collection: 'cloudflare-credentials',
        id: resolved.credentialId,
        data: {
          lastValidatedAt: new Date().toISOString(),
          lastValidationError: check.ok && check.onAccount ? null : check.message,
        } as never,
        overrideAccess: true,
      })
    }

    if (!check.ok) {
      return json({
        ok: false,
        onAccount: false,
        source: resolved.source,
        accountLabel: resolved.label,
        accountId: resolved.accountId,
        domain,
        message: check.message,
        notes,
      })
    }

    if (!check.onAccount) {
      return json({
        ok: true,
        onAccount: false,
        needsAccountChoice: true,
        source: resolved.source,
        accountLabel: resolved.label,
        accountId: resolved.accountId,
        domain,
        zoneName: check.zoneName,
        zoneAccountId: check.zoneAccountId,
        message: check.message,
        notes,
      })
    }

    return json({
      ok: true,
      onAccount: true,
      source: resolved.source,
      accountLabel: resolved.label,
      accountId: resolved.accountId,
      domain,
      zoneName: check.zoneName,
      zoneStatus: check.zoneStatus,
      message: check.message,
      notes,
    })
  },
}

/** Exported for publish endpoint body parsing. */
export { readConfirmFlag }
