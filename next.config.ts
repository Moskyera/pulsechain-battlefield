import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // three.js ships untranspiled ESM examples; Next handles it, but being explicit
  // avoids edge cases with drei's deep imports.
  transpilePackages: ['three'],
  experimental: {
    optimizePackageImports: ['@react-three/drei'],
  },
};

export default nextConfig;
