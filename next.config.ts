import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    const noStore = { key: "Cache-Control", value: "no-store" };
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/account/:path*", headers: [noStore] },
      { source: "/office/:path*", headers: [noStore] },
      { source: "/api/:path*", headers: [noStore] },
      { source: "/checkout", headers: [noStore] },
      { source: "/cart", headers: [noStore] },
    ];
  },
};

export default nextConfig;
