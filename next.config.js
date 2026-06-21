/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 是原生模块，避免 webpack 打包进 bundle
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  // 生产环境允许 instrumentation.ts 自动启动 cron 调度
  instrumentationHook: true,
  webpack: (config, { isServer }) => {
    if (isServer) {
      // 额外确保 better-sqlite3 不被打包
      config.externals = config.externals || [];
    }
    return config;
  },
};

module.exports = nextConfig;
