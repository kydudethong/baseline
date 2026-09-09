import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Traces exactly the files the server needs into .next/standalone, so the
  // runtime image does not carry the full node_modules tree. See Dockerfile.
  output: "standalone",
};

export default nextConfig;
