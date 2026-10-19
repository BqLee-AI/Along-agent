import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The browser talks to the same-origin proxy in src/app/api/[...path].
  // Server components call the API directly; cookies are forwarded explicitly.
  reactStrictMode: true,
  typedRoutes: false,
  agentRules: false,
};

export default nextConfig;
