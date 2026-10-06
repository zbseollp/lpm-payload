'use client'

import { useAuth } from '@payloadcms/ui'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'

const SETUP_PATH = '/admin/setup-totp'
const VERIFY_PATH = '/admin/verify-totp'

function isOnTotpFlow(pathname: string): boolean {
  return pathname.includes('setup-totp') || pathname.includes('verify-totp')
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  const normalized = pathname.replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

/**
 * payload-totp redirects with `router.push()` after login. On Payload 3 + Next 15
 * that often prefetches setup-totp via RSC while the login form stays visible
 * until a full reload. Hard navigation matches what users get when they refresh.
 */
export function TotpHardRedirect({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const pathname = usePathname()
  const redirecting = useRef(false)

  useEffect(() => {
    if (!user || redirecting.current) return

    const strategy = user._strategy as string | undefined
    if (strategy === 'api-key' || strategy === 'totp') return
    if (isOnTotpFlow(pathname)) return

    const back = encodeURIComponent(normalizePathname(pathname))
    const target = user.hasTotp
      ? `${VERIFY_PATH}?back=${back}`
      : `${SETUP_PATH}?back=${back}`

    redirecting.current = true
    window.location.assign(target)
  }, [user, pathname])

  return children
}
