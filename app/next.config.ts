import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // App lives inside a parent repo that has its own lockfile; pin the root here.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
