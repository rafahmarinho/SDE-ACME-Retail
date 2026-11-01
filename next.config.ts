import type { NextConfig } from "next";
import { API_CSP, BASE_SECURITY_HEADERS, CONFIDENTIAL_PAGE_SOURCES, NO_STORE_HEADERS } from "./src/lib/security-headers";

// Page Content-Security-Policy (with a per-request nonce) is set in src/proxy.ts.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Annotation retention policy: comments stay in the repository only. Production client bundles are
  // minified without comments and no browser source maps are published (checked in src/lib/release.test.ts).
  productionBrowserSourceMaps: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: BASE_SECURITY_HEADERS },
      { source: "/api/:path*", headers: [...NO_STORE_HEADERS, { key: "Content-Security-Policy", value: API_CSP }] },
      ...CONFIDENTIAL_PAGE_SOURCES.map((source) => ({ source, headers: NO_STORE_HEADERS })),
    ];
  },
};

export default nextConfig;
