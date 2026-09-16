import type { Payload } from 'payload'

import { decryptSecret } from './credentialEncryption'

export type CloudflareCredentialSource =
  | 'tenant-credential'
  | 'default-credential'
  | 'platform-env'

export interface ResolvedCloudflareCredentials {
  accountId: string
  apiToken: string
  workersDevSubdomain: string | null
  label: string
  credentialId: string | number
  source: CloudflareCredentialSource
}

type CloudflareCredentialRef =
  | number
  | string
  | {
      id?: number | string
      accountId?: string | null
      apiTokenEncrypted?: string | null
      workersDevSubdomain?: string | null
      label?: string | null
    }
  | null
  | undefined

export interface TenantCloudflareAuth {
  slug?: string | null
  cloudflareProject?: string | null
  domain?: string | null
  cloudflareCredential?: CloudflareCredentialRef
}

type CredentialDoc = {
  id: string | number
  label?: string | null
  accountId?: string | null
  apiTokenEncrypted?: string | null
  workersDevSubdomain?: string | null
  isDefault?: boolean | null
}

async function loadCredentialDoc(
  payload: Payload,
  ref: CloudflareCredentialRef,
): Promise<CredentialDoc | null> {
  if (ref == null || ref === '') return null

  if (typeof ref === 'object' && ref.apiTokenEncrypted && ref.accountId) {
    return {
      id: ref.id ?? 'inline',
      label: ref.label ?? null,
      accountId: ref.accountId,
      apiTokenEncrypted: ref.apiTokenEncrypted,
      workersDevSubdomain: ref.workersDevSubdomain ?? null,
    }
  }

  const id = typeof ref === 'object' ? ref.id : ref
  if (id == null || id === '') return null

  try {
    return (await payload.findByID({
      collection: 'cloudflare-credentials',
      id,
      depth: 0,
      overrideAccess: true,
    })) as CredentialDoc
  } catch {
    return null
  }
}

function resolveFromDoc(
  doc: CredentialDoc,
  source: Exclude<CloudflareCredentialSource, 'platform-env'>,
): ResolvedCloudflareCredentials | null {
  if (!doc.accountId || !doc.apiTokenEncrypted) return null
  try {
    const apiToken = decryptSecret(doc.apiTokenEncrypted)
    if (!apiToken) return null
    return {
      accountId: doc.accountId.trim(),
      apiToken,
      workersDevSubdomain: doc.workersDevSubdomain?.trim() || null,
      label: doc.label?.trim() || 'Cloudflare account',
      credentialId: doc.id,
      source,
    }
  } catch {
    return null
  }
}

async function findDefaultCredential(payload: Payload): Promise<CredentialDoc | null> {
  const result = await payload.find({
    collection: 'cloudflare-credentials',
    where: { isDefault: { equals: true } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return (result.docs[0] as CredentialDoc | undefined) ?? null
}

/** Legacy shared Jenkins/GHA secrets — kept so existing deploys keep working. */
export function resolvePlatformCloudflareEnv(): ResolvedCloudflareCredentials | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  if (!apiToken || !accountId) return null
  return {
    accountId,
    apiToken,
    workersDevSubdomain: process.env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN?.trim() || null,
    label: 'Platform CLOUDFLARE_* env',
    credentialId: 'env',
    source: 'platform-env',
  }
}

/**
 * Resolve Cloudflare Workers credentials for a tenant deploy.
 * 1. Tenant-linked credential
 * 2. Credential marked isDefault
 * 3. CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env (legacy, non-breaking)
 */
export async function resolveCloudflareCredentialsForTenant(
  payload: Payload,
  tenant: TenantCloudflareAuth,
): Promise<ResolvedCloudflareCredentials | null> {
  const linked = await loadCredentialDoc(payload, tenant.cloudflareCredential)
  if (linked) {
    const resolved = resolveFromDoc(linked, 'tenant-credential')
    if (resolved) return resolved
  }

  const fallback = await findDefaultCredential(payload)
  if (fallback) {
    const resolved = resolveFromDoc(fallback, 'default-credential')
    if (resolved) return resolved
  }

  return resolvePlatformCloudflareEnv()
}

/** Worker script name: cloudflareProject → tenant slug. */
export function resolveWorkerScriptName(tenant: TenantCloudflareAuth): string | null {
  const fromField = tenant.cloudflareProject?.trim()
  if (fromField) return fromField
  const slug = tenant.slug?.trim()
  return slug || null
}
