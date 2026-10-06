/**
 * Collections with public `read` access (Astro builds, unauthenticated REST)
 * must opt out of payload-totp's access wrapper on read — otherwise anonymous
 * fetches would be blocked until a user completes TOTP verification.
 */
export const totpPublicReadCustom = {
  totp: {
    disableAccessWrapper: {
      read: true,
    },
  },
} as const
