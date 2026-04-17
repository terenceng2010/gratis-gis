/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@gratis-gis/ui', '@gratis-gis/shared-types'],
  experimental: {
    // Required because our shared packages export TS directly without a build step.
    externalDir: true,
  },
};

export default nextConfig;
