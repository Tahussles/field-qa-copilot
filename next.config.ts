import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The floating dev badge sits on the sidebar; keep dev screenshots clean.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        // Our CSS only: running the Tailwind loader on node_modules CSS
        // (maplibre-gl.css) hangs the build.
        condition: { not: "foreign" },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // FastAPI lives in api/index.py. In dev it runs under uvicorn on :8000;
  // on Vercel it is a Python function served at /api.
  async rewrites() {
    return [
      {
        source: "/api/py/:path*",
        destination:
          process.env.NODE_ENV === "development"
            ? "http://127.0.0.1:8000/api/py/:path*"
            : "/api/",
      },
    ];
  },
};

export default nextConfig;
