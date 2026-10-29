import type { GlobalConfig } from 'payload'

import { isSuperAdmin } from '../access/isSuperAdmin'

/**
 * Platform-wide settings (singleton). Super-admins choose CI backend here.
 */
export const PlatformSettings: GlobalConfig = {
  slug: 'platform-settings',
  label: 'Platform settings',
  admin: {
    group: 'Platform',
    description: 'CI/CD and platform defaults. Only super-admins can edit.',
    hidden: ({ user }) => !isSuperAdmin(user),
  },
  access: {
    read: ({ req }) => isSuperAdmin(req.user),
    update: ({ req }) => isSuperAdmin(req.user),
  },
  fields: [
    {
      name: 'reloadCloudflareSecrets',
      type: 'ui',
      admin: {
        components: {
          Field: '/components/ReloadSecrets.client#ReloadSecretsPanel',
        },
      },
    },
    {
      name: 'ciProvider',
      type: 'select',
      defaultValue: 'github_actions',
      required: true,
      options: [
        {
          label: 'GitHub Actions',
          value: 'github_actions',
        },
        {
          label: 'Jenkins',
          value: 'jenkins',
        },
      ],
      admin: {
        description:
          'Where tenant pipelines run (deploy, import, scaffold, setup, scheduled publish). ' +
          'Jenkins requires JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN in server .env.',
      },
    },
    {
      name: 'jenkinsNotes',
      type: 'textarea',
      admin: {
        readOnly: true,
        description: 'Jenkins job names are configured via server env (JENKINS_JOB_DEPLOY, etc.). See jenkins/README.md.',
        condition: (_, siblingData) => siblingData?.ciProvider === 'jenkins',
      },
    },
  ],
}
