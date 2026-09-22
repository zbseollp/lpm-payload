import { withPayload } from '@payloadcms/next/withPayload'

function hostnameFromUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    return new URL(raw.trim()).hostname
  } catch {
    return null
  }
}

const publicHost = hostnameFromUrl(process.env.PAYLOAD_PUBLIC_SERVER_URL)
const extraDevOrigins = (process.env.PAYLOAD_ALLOWED_DEV_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow opening the dev server via LAN/public IP (not only localhost).
  // See: https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '49.13.135.140',
    ...(publicHost ? [publicHost] : []),
    ...extraDevOrigins,
  ],
  experimental: {
    reactCompiler: false,
    // Large CI blog-import payloads (import-blog-content).
    // proxyClientMaxBodySize is not in Next 15.4 — use serverActions.bodySizeLimit only.
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
}

export default withPayload(nextConfig);
