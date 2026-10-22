import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Phase 1 (42-S1): strict build gate — TypeScript errors fail the build.
  // No ignoreBuildErrors escape hatch; `bun run typecheck` must stay at 0 errors.
  reactStrictMode: false,
};

export default nextConfig;
