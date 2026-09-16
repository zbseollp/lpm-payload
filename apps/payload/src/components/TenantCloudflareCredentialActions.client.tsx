'use client'

import { useDocumentInfo, useField, useFormFields } from '@payloadcms/ui'
import { useCallback, useEffect, useState } from 'react'

type CredentialSummary = {
  id: number
  label: string
  accountId?: string | null
  apiTokenLast4?: string | null
  isDefault?: boolean | null
}

type ActionResult = {
  ok: boolean
  message: string
  needsAccountChoice?: boolean
  exists?: boolean
  notes?: string[]
}

function credentialIdFromValue(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number') return id
    if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id)
  }
  return null
}

/**
 * Actions card for the tenant Cloudflare credential relationship field.
 */
export function TenantCloudflareCredentialActions(): React.ReactElement | null {
  const { id: tenantId } = useDocumentInfo()
  const credentialValue = useFormFields(([fields]) => fields.cloudflareCredential?.value)
  const { setValue: setCredential } = useField<number | null>({ path: 'cloudflareCredential' })

  const credentialId = credentialIdFromValue(credentialValue)
  const [summary, setSummary] = useState<CredentialSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)

  useEffect(() => {
    if (!credentialId) {
      setSummary(null)
      return
    }
    if (typeof credentialValue === 'object' && credentialValue !== null && 'label' in credentialValue) {
      const row = credentialValue as CredentialSummary
      setSummary({
        id: credentialId,
        label: String(row.label ?? ''),
        accountId: row.accountId ?? null,
        apiTokenLast4: row.apiTokenLast4 ?? null,
        isDefault: row.isDefault ?? null,
      })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/cloudflare-credentials/${credentialId}?depth=0`, {
          credentials: 'include',
        })
        if (!res.ok) return
        const doc = (await res.json()) as CredentialSummary
        if (!cancelled) setSummary(doc)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [credentialId, credentialValue])

  const runAction = useCallback(
    async (action: string) => {
      const tid = typeof tenantId === 'string' || typeof tenantId === 'number' ? String(tenantId) : null

      if (action === 'validate') {
        if (!tid) return
        setBusy(action)
        setResult(null)
        try {
          const res = await fetch(`/api/tenants/${encodeURIComponent(tid)}/validate-cloudflare`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
          })
          const body = (await res.json().catch(() => ({}))) as Partial<ActionResult>
          setResult({
            ok: Boolean(body.ok),
            message: typeof body.message === 'string' ? body.message : 'Done.',
            needsAccountChoice: body.needsAccountChoice,
            exists: body.exists,
            notes: Array.isArray(body.notes) ? body.notes.map(String) : undefined,
          })
        } catch (err) {
          setResult({
            ok: false,
            message: err instanceof Error ? err.message : 'Network error.',
          })
        } finally {
          setBusy(null)
        }
        return
      }

      if (!credentialId) return
      setBusy(action)
      setResult(null)

      try {
        if (action === 'edit') {
          window.open(`/admin/collections/cloudflare-credentials/${credentialId}`, '_blank')
          setBusy(null)
          return
        }

        if (action === 'clear-token') {
          if (
            !window.confirm(
              'Remove the stored API token from this credential? Linked tenants will fail Cloudflare deploy until a new token is saved.',
            )
          ) {
            setBusy(null)
            return
          }
          const res = await fetch(`/api/cloudflare-credentials/${credentialId}/clear-token`, {
            method: 'POST',
            credentials: 'include',
          })
          const body = (await res.json().catch(() => ({}))) as Partial<ActionResult>
          setResult({
            ok: Boolean(body.ok),
            message: typeof body.message === 'string' ? body.message : 'Done.',
          })
          if (body.ok) {
            setSummary((s) => (s ? { ...s, apiTokenLast4: null } : s))
          }
          setBusy(null)
          return
        }

        if (action === 'unlink') {
          setCredential(null)
          setResult({
            ok: true,
            message: 'Credential unlinked. Save the tenant to use the Default Cloudflare account.',
          })
          setBusy(null)
          return
        }

        if (action === 'delete') {
          if (
            !window.confirm(
              'Delete this Cloudflare credential permanently? Tenants linked to it will need a new selection.',
            )
          ) {
            setBusy(null)
            return
          }
          const res = await fetch(`/api/cloudflare-credentials/${credentialId}`, {
            method: 'DELETE',
            credentials: 'include',
          })
          if (!res.ok) {
            setResult({ ok: false, message: `Delete failed (${res.status}).` })
          } else {
            setCredential(null)
            setSummary(null)
            setResult({ ok: true, message: 'Credential deleted. Save the tenant to apply.' })
          }
          setBusy(null)
        }
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : 'Network error.',
        })
        setBusy(null)
      }
    },
    [credentialId, setCredential, tenantId],
  )

  if (!tenantId) return null

  return (
    <div
      style={{
        border: '1px solid var(--theme-elevation-150, #e5e7eb)',
        borderRadius: 6,
        padding: '12px 16px',
        marginBottom: 20,
        background: 'var(--theme-elevation-50, #f9fafb)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Cloudflare account</div>
      {credentialId && summary ? (
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          <strong>{summary.label}</strong>
          {summary.accountId ? ` · ${summary.accountId.slice(0, 8)}…` : ''}
          {summary.isDefault ? ' · Default' : ''}
          {summary.apiTokenLast4 ? (
            <> · token ••••{summary.apiTokenLast4}</>
          ) : (
            <span style={{ color: 'var(--theme-warning-500, #b45309)' }}> · no token stored</span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--theme-elevation-500, #6b7280)' }}>
          No account selected — deploy uses the Platform credential marked Default (if any).
        </div>
      )}

      <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }} htmlFor="cf-cred-actions">
        Actions
      </label>
      <select
        id="cf-cred-actions"
        defaultValue=""
        disabled={busy !== null}
        onChange={(e) => {
          const action = e.target.value
          e.target.value = ''
          if (action) void runAction(action)
        }}
        style={{
          width: '100%',
          maxWidth: 360,
          padding: '8px 10px',
          borderRadius: 4,
          border: '1px solid var(--theme-elevation-150, #d1d5db)',
        }}
      >
        <option value="">Choose an action…</option>
        <option value="validate">Check domain on this account…</option>
        {credentialId ? <option value="edit">Edit / replace token…</option> : null}
        {credentialId ? <option value="clear-token">Delete stored token</option> : null}
        {credentialId ? <option value="unlink">Unlink (use Default account)</option> : null}
        {credentialId ? <option value="delete">Delete credential…</option> : null}
      </select>

      {result ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            padding: 10,
            borderRadius: 4,
            background: result.ok
              ? result.needsAccountChoice
                ? 'var(--theme-warning-100, #fffbeb)'
                : 'var(--theme-success-100, #ecfdf5)'
              : 'var(--theme-error-100, #fef2f2)',
          }}
        >
          <div>{result.message}</div>
          {result.notes?.length ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
