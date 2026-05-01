/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@gratis-gis/ui', '@gratis-gis/shared-types'],
  experimental: {
    // Required because our shared packages export TS directly without a build step.
    externalDir: true,
  },
  // Standalone output bundles the minimal node_modules subset that the
  // running server actually imports into a self-contained .next/standalone
  // directory. The Docker runtime stage copies that subset rather than the
  // full 1+ GB of pnpm-style node_modules, cutting the production image
  // size by ~10x. No-op for `next dev` and `next start` against a regular
  // .next build, so dev workflow is unchanged.
  output: 'standalone',
  // The standalone tracer needs to know where the workspace root is so it
  // includes packages/* deps, otherwise the build warns about multiple
  // lockfiles and may miss workspace package files at runtime.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default nextConfig;
