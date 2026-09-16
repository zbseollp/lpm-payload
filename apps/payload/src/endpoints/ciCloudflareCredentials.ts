import type { Endpoint, PayloadRequest } from 'payload'

import { isCiServiceAuthorized } from '../access/ciServiceAuth'
import {
  resolveCloudflareCredentialsForTenant,
  resolveWorkerScriptName,
  type TenantCloudflareAuth,
} from '../lib/resolveCloudflareCredentials'

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function tenantSlugFromRequest(req: PayloadRequest): string | null {
  const url = new URL(req.url ?? 'http://localhost', 'http://localhost')
  const slug = url.searchParams.get('tenant')?.trim()
  if (!slug || !/^[a-z][a-z0-9-]*$/.test(slug)) return null
  return slug
}

/**
 * CI-only: resolve Cloudflare account + API token for wrangler deploy.
 *
 *   GET /api/ci/cloudflare-credentials?tenant=<slug>
 *
 * Auth: header `x-deploy-report-token` matching DEPLOY_REPORT_TOKEN.
 * Order: tenant credential → Default credential → CLOUDFLARE_* env on Payload.
 */
export const ciCloudflareCredentialsEndpoint: Endpoint = {
  path: '/ci/cloudflare-credentials',
  method: 'get',
  handler: async (req) => {
    if (!isCiServiceAuthorized(req)) {
      return json(
        {
          ok: false,
          message:
            'Unauthorized. Send header x-deploy-report-token matching DEPLOY_REPORT_TOKEN.',
        },
        401,
      )
    }

    const slug = tenantSlugFromRequest(req)
    if (!slug) {
      return json({ ok: false, message: 'Missing or invalid ?tenant= slug query parameter.' }, 400)
    }

    const result = await req.payload.find({
      collection: 'tenants',
      where: { slug: { equals: slug } },
      limit: 1,
      depth: 1,
      overrideAccess: true,
    })

    const tenant = result.docs[0] as TenantCloudflareAuth | null
    if (!tenant) {
      return json({ ok: false, message: `Tenant "${slug}" not found.` }, 404)
    }

    const resolved = await resolveCloudflareCredentialsForTenant(req.payload, tenant)
    if (!resolved) {
      return json(
        {
          ok: false,
          message:
            'No Cloudflare credential available. Link one on the tenant, create a Default under Platform → Cloudflare credentials, or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID on Payload/CI.',
        },
        404,
      )
    }

    return json({
      ok: true,
      accountId: resolved.accountId,
      apiToken: resolved.apiToken,
      workersDevSubdomain: resolved.workersDevSubdomain,
      label: resolved.label,
      source: resolved.source,
      workerName: resolveWorkerScriptName(tenant),
      tenant: slug,
    })
  },
}
