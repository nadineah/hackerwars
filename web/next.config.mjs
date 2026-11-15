import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The theme format + validator live in ../theme-core and are shared with the browser extension.
  experimental: { externalDir: true },
  // node:sqlite and sharp are Node-only; keep them out of the bundler.
  serverExternalPackages: ['sharp'],
  poweredByHeader: false,
  outputFileTracingRoot: path.join(here, '..'),
  webpack(config) {
    // Explicit aliases: the extension repo and the site have separate lockfiles, so do not rely on tsconfig discovery.
    config.resolve.alias = { ...config.resolve.alias, '@': path.join(here, 'src'), '@theme-core': path.join(here, '..', 'theme-core', 'src', 'index.ts') };
    return config;
  },
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
