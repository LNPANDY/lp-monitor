# 多阶段构建。better-sqlite3 需要在目标平台编译原生模块。
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*

# ---- deps 阶段：安装全部依赖（含 dev，用于编译原生模块）
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ---- builder 阶段：构建 Next.js
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 生产环境构建
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner 阶段：仅含生产依赖 + 构建产物
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DB_PATH=/app/data/app.db
ENV PORT=3000

# better-sqlite3 运行时仍需要原生 .node 文件，从 deps 阶段复制
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY package.json next.config.js ./
# instrumentation.ts 与 next.config 一起由 next 读取
COPY --from=builder /app/src/instrumentation.ts ./src/instrumentation.ts

# 数据持久化目录
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
# Next.js 14 用 next start 启动；instrumentation 在生产模式下也会自动运行
CMD ["npm", "start"]
