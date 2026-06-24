const pkg = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  // Next.js 14+ 只要项目根目录存在 instrumentation.ts 即自动加载，
  // 无需（也不应）在 experimental.instrumentationHook 里显式声明——
  // 那是 Next 13 的写法，在 14 里会触发 "Unrecognized key" 警告。
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
