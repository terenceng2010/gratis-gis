// SPDX-License-Identifier: AGPL-3.0-or-later
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
  // #118 help docs.  The /help route reads .md files from
  // content/help/ via fs at request time -- the tracer can't see
  // them (no static import), so the standalone build leaves them
  // out and prod renders an empty sidebar.  Force-include the
  // tree.  Glob is rooted at the package, not the tracing root.
  outputFileTracingIncludes: {
    '/help/**/*': ['./content/help/**/*'],
  },
};

export default nextConfig;
