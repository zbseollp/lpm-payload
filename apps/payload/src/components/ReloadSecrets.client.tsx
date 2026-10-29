'use client'

import { useAuth } from '@payloadcms/ui'
import { useState } from 'react'

import { publishPanelCard, publishPrimaryButton, publishResultBox } from './publishPanelStyles'

type ReloadResult = {
  ok: boolean
  message: string
}

function isSuperAdminUser(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false
  const roles = (user as { roles?: unknown }).roles
  return Array.isArray(roles) && roles.includes('super-admin')
}

export function ReloadSecretsPanel(): React.ReactElement | null {
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReloadResult | null>(null)

  if (!isSuperAdminUser(user)) return null

  async function reload() {
    if (
      !window.confirm(
        'Reload Payload now? This restarts PM2 for a few seconds so Cloudflare Worker env vars are picked up. You will need to refresh admin after it comes back.',
      )
    ) {
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/ops/reload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string }
      setResult({
        ok: Boolean(body.ok) || res.status === 202,
        message:
          typeof body.message === 'string'
            ? body.message
            : res.ok
              ? 'PM2 reload scheduled. Wait a few seconds, then refresh.'
              : `Request failed: ${res.status} ${res.statusText}`,
      })
    } catch (err) {
      setResult({
        ok: false,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}. If the server already restarted, wait and refresh.`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ ...publishPanelCard, margin: '0 0 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Cloudflare secrets</div>
          <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.4 }}>
            After you change Worker env vars, reload Payload so PM2 picks them up.
          </div>
        </div>
        <button type="button" onClick={() => void reload()} disabled={busy} style={publishPrimaryButton(busy)}>
          {busy ? 'Reloading…' : 'Reload env'}
        </button>
      </div>
      {result ? <div style={publishResultBox(result.ok)}>{result.message}</div> : null}
    </div>
  )
}
