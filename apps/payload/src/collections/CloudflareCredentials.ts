import type { CollectionConfig } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'
import { clearCloudflareCredentialTokenEndpoint } from '../endpoints/cloudflareCredentialActions'
import { encryptSecret } from '../lib/credentialEncryption'

export const CloudflareCredentials: CollectionConfig = {
  slug: 'cloudflare-credentials',
  endpoints: [clearCloudflareCredentialTokenEndpoint],
  labels: { singular: 'Cloudflare credential', plural: 'Cloudflare credentials' },
  admin: {
    useAsTitle: 'label',
    group: 'Platform',
    description:
      'Encrypted Cloudflare API tokens per account. Tenants pick an account for Workers deploy; if unset, the credential marked Default is used. GitHub Actions resolves credentials from Payload after build (tokens are never exposed to client install/build). Optional shared CLOUDFLARE_* repo secrets remain a last-resort fallback.',
    hidden: ({ user }) => !isSuperAdmin(user),
    defaultColumns: ['label', 'accountId', 'isDefault', 'apiTokenLast4', 'lastValidatedAt'],
  },
  access: {
    read: ({ req }) => isSuperAdmin(req.user),
    create: ({ req }) => isSuperAdmin(req.user),
    update: ({ req }) => isSuperAdmin(req.user),
    delete: ({ req }) => isSuperAdmin(req.user),
  },
  hooks: {
    beforeValidate: [
      ({ data, operation }) => {
        if (!data || typeof data !== 'object') return data
        const row = data as Record<string, unknown>
        const token = typeof row.apiToken === 'string' ? row.apiToken.trim() : ''
        const hasEncrypted =
          typeof row.apiTokenEncrypted === 'string' && row.apiTokenEncrypted.length > 0
        if (operation === 'create' && !token && !hasEncrypted) {
          throw new Error(
            'Cloudflare API token is required. Paste a token in the API token field and save.',
          )
        }
        const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : ''
        if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
          throw new Error('Cloudflare Account ID should be a 32-character hex string.')
        }
        return data
      },
    ],
    beforeChange: [
      async ({ data, req, originalDoc }) => {
        if (!data || typeof data !== 'object') return data
        const row = data as Record<string, unknown>
        const token = typeof row.apiToken === 'string' ? row.apiToken.trim() : ''
        if (token) {
          row.apiTokenEncrypted = encryptSecret(token)
          row.apiTokenLast4 = token.length >= 4 ? token.slice(-4) : token
        }

        // Exactly one default: clear others when this row becomes default.
        if (row.isDefault === true) {
          const selfId = originalDoc?.id
          const others = await req.payload.find({
            collection: 'cloudflare-credentials',
            where: {
              and: [
                { isDefault: { equals: true } },
                ...(selfId != null ? [{ id: { not_equals: selfId } }] : []),
              ],
            },
            limit: 50,
            depth: 0,
            overrideAccess: true,
          })
          for (const doc of others.docs) {
            await req.payload.update({
              collection: 'cloudflare-credentials',
              id: doc.id,
              data: { isDefault: false } as never,
              overrideAccess: true,
            })
          }
        }

        return row
      },
    ],
  },
  fields: [
    {
      name: 'label',
      type: 'text',
      required: true,
      admin: {
        description: 'e.g. "Account A (default)" — shown when linking a tenant.',
      },
    },
    {
      name: 'accountId',
      type: 'text',
      required: true,
      admin: {
        description: 'Cloudflare Account ID (32-char hex from the dashboard URL / Workers overview).',
      },
    },
    {
      name: 'isDefault',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Use for tenants with no Cloudflare account selected. Only one credential should be default.',
      },
    },
    {
      name: 'workersDevSubdomain',
      type: 'text',
      admin: {
        description:
          'Optional workers.dev subdomain for this account (e.g. twilight-breeze-d943). Used when guessing preview URLs.',
      },
    },
    {
      name: 'apiToken',
      type: 'text',
      virtual: true,
      admin: { hidden: true },
    },
    {
      name: 'tokenPanel',
      type: 'ui',
      admin: {
        components: {
          Field: '/components/CloudflareCredentialTokenField.client#CloudflareCredentialTokenPanel',
        },
      },
    },
    {
      name: 'apiTokenLast4',
      type: 'text',
      admin: {
        readOnly: true,
        description: 'Last four characters of the stored API token.',
      },
    },
    {
      name: 'apiTokenEncrypted',
      type: 'text',
      access: { read: () => false },
      admin: { hidden: true, readOnly: true },
    },
    {
      name: 'notes',
      type: 'textarea',
      admin: { description: 'Permissions needed: Zone Read, Workers Scripts Edit, Account Read.' },
    },
    {
      name: 'lastValidatedAt',
      type: 'date',
      admin: {
        readOnly: true,
        date: { pickerAppearance: 'dayAndTime' },
      },
    },
    {
      name: 'lastValidationError',
      type: 'text',
      admin: { readOnly: true },
    },
  ],
}
