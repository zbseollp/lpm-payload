import type { CollectionConfig, CollectionBeforeOperationHook } from 'payload'

import { authenticatedRead, cmsApiRead } from '../access/tenantAccess'
import { totpPublicReadCustom } from '../access/totpPublicRead'

/**
 * Prefix every uploaded media key with `tenants/<slug>/...` so a single R2
 * bucket can safely host all tenants without filename collisions.
 *
 * The `@payloadcms/storage-s3` plugin reads `prefix` from the upload doc; we
 * compute it from the related tenant before the operation.
 */
const setTenantPrefix: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const data = (args.data ?? {}) as Record<string, unknown>
  const tenantRef = data.tenant
  if (!tenantRef) return args
  try {
    const tenant = (await req.payload.findByID({
      collection: 'tenants',
      id: tenantRef as string | number,
    })) as { slug?: string } | null
    if (tenant?.slug) {
      data.prefix = `tenants/${tenant.slug}`
      args.data = data
    }
  } catch {
    /* leave prefix unset; bucket-level prefix from s3Storage plugin still applies */
  }
  return args
}

export const Media: CollectionConfig = {
  slug: 'media',
  custom: totpPublicReadCustom,
  labels: { singular: 'Media', plural: 'Media' },
  admin: {
    useAsTitle: 'filename',
    group: 'Content',
    description:
      'Images and files for blog posts (hero, featured, SEO). With R2 configured, uploads are stored in your Cloudflare bucket.',
  },
  access: {
    read: cmsApiRead,
    create: authenticatedRead,
    update: authenticatedRead,
    delete: authenticatedRead,
  },
  upload: {
    mimeTypes: ['image/*', 'application/pdf', 'video/*'],
    imageSizes: [
      { name: 'thumbnail', width: 400, height: 300, position: 'centre' },
      { name: 'card', width: 768 },
      { name: 'feature', width: 1280 },
      { name: 'og', width: 1200, height: 630, position: 'centre' },
    ],
  },
  hooks: {
    beforeOperation: [setTenantPrefix],
  },
  fields: [
    { name: 'alt', type: 'text' },
    {
      name: 'caption',
      type: 'text',
    },
    // Required for @payloadcms/storage-s3 per-tenant keys (set in setTenantPrefix).
    {
      name: 'prefix',
      type: 'text',
      admin: {
        hidden: true,
        readOnly: true,
      },
    },
    // tenant rel injected by the multi-tenant plugin.
  ],
}
