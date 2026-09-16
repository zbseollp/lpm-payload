/**
 * Cloudflare API helpers for deploy pre-checks.
 * Prefer domain/zone ownership over worker script lists — workers can be
 * wrongly duplicated across accounts; the DNS zone shows where the site lives.
 */

export type CloudflareDomainCheck = {
  ok: boolean
  /** Zone found on the credential's account. */
  onAccount: boolean
  status: number
  domain: string
  zoneName: string | null
  zoneStatus: string | null
  accountId: string
  zoneAccountId: string | null
  message: string
}

/** Hostnames to try as Cloudflare zone names (apex first after stripping www). */
export function candidateZoneNames(domain: string): string[] {
  let host = domain.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  if (!host || host.includes(' ')) return []
  if (host.startsWith('www.')) host = host.slice(4)

  const parts = host.split('.').filter(Boolean)
  if (parts.length < 2) return host ? [host] : []

  const out: string[] = []
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join('.'))
  }
  return out
}

/**
 * Check whether `domain` (or its apex zone) is a Cloudflare zone visible to this
 * API token / account. Account-scoped tokens only see zones on that account.
 */
export async function checkCloudflareDomainOnAccount(opts: {
  accountId: string
  apiToken: string
  domain: string
}): Promise<CloudflareDomainCheck> {
  const { accountId, apiToken, domain } = opts
  const candidates = candidateZoneNames(domain)
  if (!candidates.length) {
    return {
      ok: false,
      onAccount: false,
      status: 0,
      domain,
      zoneName: null,
      zoneStatus: null,
      accountId,
      zoneAccountId: null,
      message: `Invalid domain "${domain}".`,
    }
  }

  try {
    for (const zoneName of candidates) {
      const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}&per_page=5`
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      })

      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => '')
        return {
          ok: false,
          onAccount: false,
          status: res.status,
          domain,
          zoneName: null,
          zoneStatus: null,
          accountId,
          zoneAccountId: null,
          message: `Cloudflare API auth error ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}. Token needs Zone:Read.`,
        }
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return {
          ok: false,
          onAccount: false,
          status: res.status,
          domain,
          zoneName: null,
          zoneStatus: null,
          accountId,
          zoneAccountId: null,
          message: `Cloudflare API error ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        }
      }

      const json = (await res.json()) as {
        success?: boolean
        result?: Array<{
          name?: string
          status?: string
          account?: { id?: string; name?: string }
        }>
      }

      const zones = Array.isArray(json.result) ? json.result : []
      const match = zones.find((z) => z.name?.toLowerCase() === zoneName.toLowerCase())
      if (!match) continue

      const zoneAccountId = match.account?.id?.trim() || null
      if (zoneAccountId && zoneAccountId !== accountId) {
        return {
          ok: true,
          onAccount: false,
          status: res.status,
          domain,
          zoneName: match.name ?? zoneName,
          zoneStatus: match.status ?? null,
          accountId,
          zoneAccountId,
          message: `Domain zone "${match.name}" is on a different Cloudflare account (${zoneAccountId.slice(0, 8)}…) than this credential (${accountId.slice(0, 8)}…).`,
        }
      }

      return {
        ok: true,
        onAccount: true,
        status: res.status,
        domain,
        zoneName: match.name ?? zoneName,
        zoneStatus: match.status ?? null,
        accountId,
        zoneAccountId: zoneAccountId ?? accountId,
        message: `Domain zone "${match.name ?? zoneName}" is on this Cloudflare account${match.status ? ` (status: ${match.status})` : ''}.`,
      }
    }

    return {
      ok: true,
      onAccount: false,
      status: 200,
      domain,
      zoneName: null,
      zoneStatus: null,
      accountId,
      zoneAccountId: null,
      message: `Domain "${domain}" was not found as a zone on this Cloudflare account. Pick the account where this domain’s DNS lives.`,
    }
  } catch (err) {
    return {
      ok: false,
      onAccount: false,
      status: 0,
      domain,
      zoneName: null,
      zoneStatus: null,
      accountId,
      zoneAccountId: null,
      message: err instanceof Error ? err.message : 'Cloudflare API request failed.',
    }
  }
}
