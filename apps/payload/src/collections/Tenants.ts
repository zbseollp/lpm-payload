import type { CollectionConfig } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'
import { totpPublicReadCustom } from '../access/totpPublicRead'
import { cmsApiRead } from '../access/tenantAccess'
import { importBlogContentEndpoint } from '../endpoints/importBlogCi'
import {
  reportDeployEndpoint,
  reportGithubSetupEndpoint,
  reportScaffoldEndpoint,
} from '../endpoints/reportDeploy'
import {
  importBlogFromRepoEndpoint,
  setupGithubRepoEndpoint,
  validateGithubEndpoint,
} from '../endpoints/tenantGithub'
import { validateCloudflareEndpoint } from '../endpoints/tenantCloudflare'
import { deployEndpoint, publishEndpoint, scaffoldEndpoint } from '../endpoints/tenantActions'
import { payloadLog } from '../lib/payloadLogger'
import { tenantAfterDeleteHook, tenantBeforeDeleteHook } from '../lib/tenantDeleteCleanup'
import { DEPLOY_STATUSES, SCAFFOLD_STATUSES } from '../lib/tenantDeployStatus'

/**
 * A tenant = one website. Owns its domain, theme tokens, analytics IDs,
 * affiliate config, and SEO defaults. Every other collection's rows belong
 * to exactly one tenant (enforced by @payloadcms/plugin-multi-tenant).
 */
export const Tenants: CollectionConfig = {
  slug: 'tenants',
  custom: totpPublicReadCustom,
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'slug', 'domain', 'lastDeployStatus', 'lastDeployAt'],
    group: 'Platform',
    description:
      'Platform sites (domains, branding, deploy). Only Super Admins can create or edit tenants.',
    hidden: ({ user }) => !isSuperAdmin(user),
  },
  access: {
    // REST read: API key (PAYLOAD_API_KEY) or CI service token — not public.
    read: cmsApiRead,
    create: ({ req }) => isSuperAdmin(req.user),
    update: ({ req }) => isSuperAdmin(req.user),
    delete: ({ req }) => isSuperAdmin(req.user),
  },
  hooks: {
    beforeChange: [
      ({ data, operation, req }) => {
        payloadLog.tenant('save.start', {
          operation,
          slug: (data as { slug?: string })?.slug,
          userId: req.user?.id ?? null,
        })
        return data
      },
    ],
    afterChange: [
      ({ doc, operation, req }) => {
        payloadLog.tenant('save.done', {
          operation,
          tenantId: doc.id,
          slug: doc.slug,
          userId: req.user?.id ?? null,
        })
        return doc
      },
    ],
    beforeDelete: [tenantBeforeDeleteHook],
    afterDelete: [tenantAfterDeleteHook],
    beforeValidate: [
      ({ data, operation }) => {
        if (operation !== 'create' || !data || typeof data !== 'object') return data
        const row = data as Record<string, unknown>
        const name = typeof row.name === 'string' ? row.name.trim() : ''
        const slug = typeof row.slug === 'string' ? row.slug.trim() : ''
        if (!slug && name) {
          let generated = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
          if (generated && !/^[a-z]/.test(generated)) generated = `t-${generated}`
          if (generated) row.slug = generated
        }
        if (!row.siteTitle && name) row.siteTitle = name
        if (!row.siteDescription && name) row.siteDescription = name
        return row
      },
    ],
  },
  endpoints: [
    scaffoldEndpoint,
    publishEndpoint,
    deployEndpoint,
    validateGithubEndpoint,
    validateCloudflareEndpoint,
    setupGithubRepoEndpoint,
    importBlogFromRepoEndpoint,
    reportDeployEndpoint,
    reportScaffoldEndpoint,
    reportGithubSetupEndpoint,
    importBlogContentEndpoint,
  ],
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      hooks: {
        beforeValidate: [
          ({ value }) =>
            typeof value === 'string' ? value.trim().toLowerCase() : value,
        ],
      },
      validate: ((value: unknown) => {
        if (typeof value !== 'string' || value.length === 0) return 'Slug is required.'
        if (!/^[a-z][a-z0-9-]*$/.test(value)) {
          return 'Slug must be lowercase letters, digits, and hyphens only, starting with a letter. e.g. keukenfaqs, my-second-site.'
        }
        return true
      }) as never,
      admin: {
        description:
          'Used as the tenant identifier in URLs, builds, and Wrangler project names. Lowercase letters, digits, and hyphens only — auto-normalized on save.',
      },
    },
    {
      name: 'domain',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Primary domain, e.g. keukenfaqs.nl (no protocol).',
      },
    },
    {
      name: 'locale',
      type: 'select',
      required: true,
      defaultValue: 'nl-NL',
      options: [
        { label: 'Dutch (Netherlands)', value: 'nl-NL' },
        { label: 'English (United Kingdom)', value: 'en-GB' },
        { label: 'English (United States)', value: 'en-US' },
        { label: 'German (Germany)', value: 'de-DE' },
        { label: 'French (France)', value: 'fr-FR' },
        { label: 'Spanish (Spain)', value: 'es-ES' },
      ],
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Branding',
          fields: [
            {
              name: 'logo',
              type: 'upload',
              relationTo: 'media',
            },
            {
              name: 'favicon',
              type: 'upload',
              relationTo: 'media',
            },
            {
              name: 'ogImage',
              type: 'upload',
              relationTo: 'media',
              admin: { description: 'Default Open Graph image (1200×630).' },
            },
            {
              name: 'themeTokens',
              type: 'group',
              admin: { description: 'Emitted as CSS variables in the tenant site.' },
              fields: [
                {
                  type: 'row',
                  fields: [
                    { name: 'primary', type: 'text', defaultValue: '#1d3557' },
                    { name: 'primaryDark', type: 'text', defaultValue: '#0d1b2a' },
                    { name: 'accent', type: 'text', defaultValue: '#e76f51' },
                    { name: 'background', type: 'text', defaultValue: '#ffffff' },
                    { name: 'text', type: 'text', defaultValue: '#0f172a' },
                    { name: 'muted', type: 'text', defaultValue: '#6b7280' },
                  ],
                },
                {
                  type: 'row',
                  fields: [
                    {
                      name: 'fontHeading',
                      type: 'text',
                      defaultValue: 'Inter',
                    },
                    {
                      name: 'fontBody',
                      type: 'text',
                      defaultValue: 'Inter',
                    },
                    {
                      name: 'radius',
                      type: 'text',
                      defaultValue: '0.5rem',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          label: 'SEO',
          fields: [
            { name: 'siteTitle', type: 'text', required: true },
            { name: 'siteDescription', type: 'textarea', required: true },
            { name: 'titleSuffix', type: 'text' },
            {
              name: 'robots',
              type: 'select',
              options: ['index,follow', 'noindex,follow', 'noindex,nofollow'],
              defaultValue: 'index,follow',
            },
          ],
        },
        {
          label: 'Analytics',
          fields: [
            { name: 'ga4Id', type: 'text', admin: { description: 'e.g. G-43H5NMZVHK' } },
            { name: 'gtmId', type: 'text' },
            { name: 'plausibleDomain', type: 'text' },
          ],
        },
        {
          label: 'Social',
          fields: [
            {
              name: 'socialLinks',
              type: 'array',
              fields: [
                {
                  name: 'platform',
                  type: 'select',
                  required: true,
                  options: ['facebook', 'instagram', 'twitter', 'youtube', 'tiktok', 'pinterest', 'linkedin'],
                },
                { name: 'url', type: 'text', required: true },
              ],
            },
          ],
        },
        {
          label: 'GitHub',
          fields: [
            {
              name: 'githubConnect',
              type: 'ui',
              admin: {
                components: {
                  Field: '/components/TenantGitHubConnect.client#TenantGitHubConnect',
                },
              },
            },
            {
              name: 'githubRepo',
              type: 'text',
              admin: {
                description:
                  'Client site repository: owner/repo or https://github.com/owner/repo. When set, publish deploys from this repo instead of apps/sites/<slug>.',
              },
            },
            {
              name: 'githubBranch',
              type: 'text',
              defaultValue: 'main',
              admin: { description: 'Branch to checkout for build and setup.' },
            },
            {
              name: 'githubCredential',
              type: 'relationship',
              relationTo: 'github-credentials',
              admin: {
                description:
                  'Optional PAT for this client repo (encrypted). When empty, CI uses EXTERNAL_REPO_GITHUB_TOKEN / GITHUB_TOKEN (legacy).',
              },
            },
            {
              name: 'githubCredentialActions',
              type: 'ui',
              admin: {
                components: {
                  Field:
                    '/components/TenantGithubCredentialActions.client#TenantGithubCredentialActions',
                },
              },
            },
            {
              name: 'enabledModules',
              type: 'select',
              hasMany: true,
              defaultValue: ['blog'],
              options: [{ label: 'Blog', value: 'blog' }],
              admin: {
                description: 'CMS modules synced on publish. Only blog is supported today.',
              },
            },
            {
              name: 'blogContentPath',
              type: 'text',
              defaultValue: 'src/content/blog',
              admin: {
                description:
                  'Path inside the Astro repo where blog files are written on publish (e.g. content/blog or src/content/blog).',
              },
            },
            {
              name: 'blogFileExtension',
              type: 'select',
              defaultValue: 'md',
              options: [
                { label: 'Markdown (.md)', value: 'md' },
                { label: 'MDX (.mdx)', value: 'mdx' },
              ],
              admin: {
                description:
                  'File extension for blog posts synced from Payload on publish. Match your Astro content collection (e.g. MDX sites use .mdx). Import accepts both .md and .mdx.',
              },
            },
            {
              name: 'githubSetupStatus',
              type: 'select',
              defaultValue: 'not_connected',
              options: [
                { label: 'Not connected', value: 'not_connected' },
                { label: 'Validated', value: 'validated' },
                { label: 'Setup dispatched', value: 'setup_dispatched' },
                { label: 'Ready', value: 'ready' },
                { label: 'Failed', value: 'failed' },
              ],
              admin: { readOnly: true },
            },
            {
              name: 'githubValidationNotes',
              type: 'textarea',
              admin: { readOnly: true, description: 'Output from the last repository validation.' },
            },
          ],
        },
        {
          label: 'Deploy',
          fields: [
            {
              name: 'cloudflareProject',
              type: 'text',
              admin: { description: 'Wrangler project name (defaults to slug).' },
            },
            {
              name: 'cloudflareCredential',
              type: 'relationship',
              relationTo: 'cloudflare-credentials',
              admin: {
                description:
                  'Cloudflare account for Workers deploy (encrypted API token). When empty, uses the Platform credential marked Default, then shared CLOUDFLARE_* CI secrets.',
              },
            },
            {
              name: 'cloudflareCredentialActions',
              type: 'ui',
              admin: {
                components: {
                  Field:
                    '/components/TenantCloudflareCredentialActions.client#TenantCloudflareCredentialActions',
                },
              },
            },
            {
              name: 'githubWorkflow',
              type: 'text',
              defaultValue: 'tenant-deploy.yml',
              admin: { description: 'GitHub Actions workflow file used to rebuild this tenant.' },
            },
            {
              name: 'webhookEnabled',
              type: 'checkbox',
              defaultValue: false,
              admin: {
                description:
                  'Legacy: auto-deploy on every save via webhook. Leave off — editors use Publish content instead.',
              },
            },
            {
              name: 'lastPublishedAt',
              type: 'date',
              admin: {
                readOnly: true,
                date: { pickerAppearance: 'dayAndTime' },
                description: 'When Publish content was last clicked (CI started).',
              },
            },
            {
              name: 'blogImportedFromRepoAt',
              type: 'date',
              admin: {
                readOnly: true,
                date: { pickerAppearance: 'dayAndTime' },
                description:
                  'When blog markdown was last imported from the connected repo into Payload (also set automatically on first publish if CMS had no posts).',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'workersDevUrl',
                  type: 'text',
                  admin: {
                    readOnly: true,
                    description:
                      'Default *.workers.dev URL after deploy. Set automatically by CI; attach your custom domain in Cloudflare separately.',
                  },
                },
                {
                  name: 'previewUrl',
                  type: 'text',
                  admin: {
                    readOnly: true,
                    description:
                      'Smoke-test URL before DNS cutover (usually the same as workers.dev until a staging worker exists).',
                  },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'lastDeployStatus',
                  type: 'select',
                  defaultValue: 'idle',
                  options: DEPLOY_STATUSES.map((value) => ({ label: value, value })),
                  admin: { readOnly: true },
                },
                {
                  name: 'lastDeployAt',
                  type: 'date',
                  admin: {
                    readOnly: true,
                    date: { pickerAppearance: 'dayAndTime' },
                  },
                },
              ],
            },
            {
              name: 'lastDeployRunUrl',
              type: 'text',
              admin: { readOnly: true, description: 'Direct link to the latest GitHub Actions deploy run.' },
            },
            {
              name: 'lastDeployError',
              type: 'textarea',
              admin: { readOnly: true, description: 'Last deploy failure message (cleared on success).' },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'lastScaffoldStatus',
                  type: 'select',
                  defaultValue: 'idle',
                  options: SCAFFOLD_STATUSES.map((value) => ({ label: value, value })),
                  admin: { readOnly: true },
                },
                {
                  name: 'lastScaffoldAt',
                  type: 'date',
                  admin: {
                    readOnly: true,
                    date: { pickerAppearance: 'dayAndTime' },
                  },
                },
              ],
            },
            {
              name: 'lastScaffoldRunUrl',
              type: 'text',
              admin: { readOnly: true },
            },
            {
              name: 'lastScaffoldPrUrl',
              type: 'text',
              admin: { readOnly: true, description: 'Pull request opened by the scaffold workflow.' },
            },
            {
              name: 'lastScaffoldError',
              type: 'textarea',
              admin: { readOnly: true },
            },
          ],
        },
      ],
    },
    {
      name: 'actions',
      type: 'ui',
      admin: {
        components: {
          Field: '/components/TenantActions.client#TenantActions',
        },
      },
    },
    {
      name: 'deployLinks',
      type: 'ui',
      admin: {
        components: {
          Field: '/components/TenantDeployLinks.client#TenantDeployLinks',
        },
      },
    },
  ],
}
