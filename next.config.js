const pkg = require("./package.json");
const skipChecks = process.env.SKIP_BUILD_CHECKS === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 服务端外部化大体积/原生依赖，避免 30+ API 路由每次构建被 webpack 重复打包
    serverComponentsExternalPackages: ["better-sqlite3", "viem", "node-cron"],
  },
  // 服务器部署通过 SKIP_BUILD_CHECKS=1 跳过重复的类型检查与 ESLint（本地/CI 跑 npm run build 仍严格检查）
  typescript: {
    ignoreBuildErrors: skipChecks,
  },
  eslint: {
    ignoreDuringBuilds: skipChecks,
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
