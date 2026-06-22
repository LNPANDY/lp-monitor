const pkg = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  instrumentationHook: true,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
    }
    return config;
  },
  // 注入版本号到客户端（前端通过 process.env.NEXT_PUBLIC_VERSION 读取）
  env: {
    NEXT_PUBLIC_VERSION: pkg.version,
  },
};

module.exports = nextConfig;
