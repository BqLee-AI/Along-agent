import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The browser talks to the same-origin proxy in src/app/api/[...path].
  // Server components call the API directly; cookies are forwarded explicitly.
  reactStrictMode: true,
  typedRoutes: false,
  agentRules: false,
  async headers() {
    return [
      '/account',
      '/login',
      '/logout',
      '/setup',
      '/claim',
      '/invite',
      '/reset-password',
      '/verify-contact',
      '/forgot-password',
    ].map((source) => ({
      source,
      headers: [
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    }));
  },
};

export default nextConfig;
