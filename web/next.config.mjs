/** @type {import('next').NextConfig} */
const nextConfig = {
  // The theme format + validator live in ../theme-core and are shared with the browser extension.
  experimental: { externalDir: true },
  // node:sqlite and sharp are Node-only; keep them out of the bundler.
  serverExternalPackages: ['sharp'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default nextConfig;
