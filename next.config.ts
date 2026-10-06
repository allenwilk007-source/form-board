import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Proper 401 and 403 pages via unauthorized() and forbidden().
  experimental: { authInterrupts: true },
  poweredByHeader: false,
};

export default nextConfig;
