/** @type {import('next').NextConfig} */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Turbopack (Next 16) requires the monorepo root in workspaces — without
// this, builds/dev fail to resolve packages outside apps/web.
const turbopackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  turbopack: { root: turbopackRoot },
  transpilePackages: ["@nimbus/shared"],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
