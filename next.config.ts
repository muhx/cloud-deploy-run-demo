import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained build for small Docker images.
  output: "standalone",
  // Bake the git commit id into the bundle so the frontend can display it.
  // Set COMMIT_SHA at build time (Docker build arg / CI); falls back to "dev".
  env: {
    NEXT_PUBLIC_COMMIT_SHA: process.env.COMMIT_SHA ?? "dev",
  },
};

export default nextConfig;
