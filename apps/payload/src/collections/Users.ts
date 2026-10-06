import type { CollectionConfig } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'

/**
 * Decide whether to set the `Secure` flag on the auth cookie:
 *   - Set PAYLOAD_COOKIE_SECURE=false  → cookies work over plain http://
 *     (use this when running on a server without SSL yet — e.g.
 *     http://your-ip:3000 or http://yourdomain.com).
 *   - Set PAYLOAD_COOKIE_SECURE=true   → force secure cookies (HTTPS only).
 *   - Leave unset → defaults to: secure only if PAYLOAD_PUBLIC_SERVER_URL
 *     starts with https://. This is the right default for almost everyone.
 */
const cookieSecure = (() => {
  const explicit = process.env.PAYLOAD_COOKIE_SECURE
  if (explicit === 'true') return true
  if (explicit === 'false') return false
  return process.env.PAYLOAD_PUBLIC_SERVER_URL?.startsWith('https://') ?? false
})()

export const Users: CollectionConfig = {
  slug: 'users',
  // Allow GET /api/users/me during setup-totp / verify-totp (password session, no TOTP cookie yet).
  custom: {
    totp: {
      disableAccessWrapper: {
        read: true,
      },
    },
  },
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'roles'],
    group: 'Platform',
  },
  auth: {
    useAPIKey: true,
    cookies: {
      // SameSite=lax + Secure (when on HTTPS) is the right combo for an
      // admin reached from its own origin. When deploying behind a reverse
      // proxy that terminates TLS, X-Forwarded-Proto must be set so Next.js
      // sees the request as https.
      sameSite: 'Lax',
      secure: cookieSecure,
    },
  },
  access: {
    admin: ({ req }) => Boolean(req.user),
    read: ({ req }) => {
      if (isSuperAdmin(req.user)) return true
      return { id: { equals: req.user?.id } }
    },
    create: ({ req }) => isSuperAdmin(req.user),
    update: ({ req }) => {
      if (isSuperAdmin(req.user)) return true
      return { id: { equals: req.user?.id } }
    },
    delete: ({ req }) => isSuperAdmin(req.user),
  },
  fields: [
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'roles',
      type: 'select',
      hasMany: true,
      required: true,
      defaultValue: ['editor'],
      saveToJWT: true,
      options: [
        { label: 'Super Admin', value: 'super-admin' },
        { label: 'Tenant Admin', value: 'tenant-admin' },
        { label: 'Editor', value: 'editor' },
      ],
      admin: {
        description:
          'Super Admin — create/edit tenants and all sites. Tenant Admin / Editor — assigned sites only (blog & media).',
      },
      access: {
        update: ({ req }) => isSuperAdmin(req.user),
      },
    },
    // tenants[] is auto-added by @payloadcms/plugin-multi-tenant.
  ],
}
