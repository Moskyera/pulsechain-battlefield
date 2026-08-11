import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Served under cryptodust.xyz/battlefield via a rewrite from the main site.
  basePath: '/battlefield',
  async redirects() {
    // The bare deployment root would otherwise 404 (everything lives under basePath).
    return [{ source: '/', destination: '/battlefield', basePath: false, permanent: false }];
  },
  // three.js ships untranspiled ESM examples; Next handles it, but being explicit
  // avoids edge cases with drei's deep imports.
  transpilePackages: ['three'],
  experimental: {
    optimizePackageImports: ['@react-three/drei'],
  },
};

export default nextConfig;
