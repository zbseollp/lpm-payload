import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { payloadTotp } from 'payload-totp'
import sharp from 'sharp'

import { Tenants } from './collections/Tenants'
import { Users } from './collections/Users'
import { BlogPosts } from './collections/BlogPosts'
import { Media } from './collections/Media'
import { GithubCredentials } from './collections/GithubCredentials'
import { CloudflareCredentials } from './collections/CloudflareCredentials'
import { PlatformSettings } from './globals/PlatformSettings'
import { isSuperAdmin } from './access/isSuperAdmin'
import { ciGithubTokenEndpoint } from './endpoints/ciGithubToken'
import { ciCloudflareCredentialsEndpoint } from './endpoints/ciCloudflareCredentials'
import { scheduledPublishEndpoint } from './endpoints/scheduledPublish'
import { r2StoragePlugin } from './lib/r2Storage'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const r2Plugin = r2StoragePlugin()

function buildOriginList(): string[] {
  const list = new Set<string>()
  const server = process.env.PAYLOAD_PUBLIC_SERVER_URL?.replace(/\/+$/, '')
  if (server) list.add(server)
  const extra = process.env.PAYLOAD_ALLOWED_ORIGINS?.split(',') ?? []
  for (const o of extra) {
    const trimmed = o.trim().replace(/\/+$/, '')
    if (trimmed) list.add(trimmed)
  }
  if (process.env.NODE_ENV !== 'production') {
    list.add('http://localhost:3000')
  }
  return Array.from(list)
}

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: {
      titleSuffix: ' — LPM Payload',
    },
    components: {
      graphics: {
        Logo: '/components/AdminBrand#AdminLogo',
        Icon: '/components/AdminBrand#AdminIcon',
      },
      providers: [
        {
          path: '@/components/TotpHardRedirect.client#TotpHardRedirect',
        },
      ],
    },
  },

  collections: [Tenants, Users, BlogPosts, Media, GithubCredentials, CloudflareCredentials],

  globals: [PlatformSettings],

  endpoints: [ciGithubTokenEndpoint, ciCloudflareCredentialsEndpoint, scheduledPublishEndpoint],

  editor: lexicalEditor({}),

  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
    push: process.env.NODE_ENV !== 'production',
  }),

  sharp,

  secret: process.env.PAYLOAD_SECRET || '',
  serverURL: process.env.PAYLOAD_PUBLIC_SERVER_URL,

  cors: buildOriginList(),
  csrf: buildOriginList(),

  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },

  plugins: [
    multiTenantPlugin({
      collections: {
        'blog-posts': {},
        media: {},
      },
      tenantField: {
        name: 'tenant',
      },
      tenantsArrayField: {
        // Must be true (or add a manual `tenants` field on Users) — the plugin
        // queries user.tenants when assigning/removing tenant access.
        includeDefaultField: true,
      },
      // Tenants collection uses explicit super-admin access in Tenants.ts.
      // The plugin default adds `id in user.tenants`, which blocks creating new
      // tenants (no id yet) and locks the form after a failed save.
      useTenantsCollectionAccess: false,
      // Do not scope the Tenants list to the navbar tenant switcher — super-admins
      // manage all sites; filtering hides rows and confuses create/edit.
      useTenantsListFilter: false,
      // Custom cleanup in Tenants.ts (logged, timeout-bounded). Plugin cleanup can
      // hang DELETE when many blog posts exist or users_tenants queries fail.
      cleanupAfterTenantDelete: false,
      userHasAccessToAllTenants: (user) => isSuperAdmin(user),
    }),

    r2Plugin,

    // Must stay last — wraps access controls for TOTP verification on admin login.
    // Issuer is hardcoded so a stale PAYLOAD_TOTP_ISSUER=astropayload on the server
    // cannot keep showing the old name in authenticator apps.
    payloadTotp({
      collection: 'users',
      forceSetup: true,
      totp: {
        issuer: 'LPM',
      },
    }),
  ],
})
