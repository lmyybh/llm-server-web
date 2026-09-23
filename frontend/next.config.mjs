/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";

function normalizeGatewayPrefix(value) {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

const gatewayPrefix = normalizeGatewayPrefix(process.env.NEXT_PUBLIC_GATEWAY_PREFIX);

const nextConfig = {
  // The platform gateway strips this prefix before forwarding the request to
  // Next.js, so assets must be *requested with* it — hence assetPrefix rather
  // than basePath. Inlined at build time; changing it needs a rebuild.
  ...(gatewayPrefix ? { assetPrefix: gatewayPrefix } : {}),

  async rewrites() {
    return [
      // The browser only ever talks to this origin. Proxying /api/* to the
      // backend means the gateway needs one route instead of two, the backend
      // can stay on a private address, and no request is cross-origin — so
      // CORS never enters the picture in a deployed setup.
      { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
    ];
  },
};

export default nextConfig;
