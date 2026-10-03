# ===== 阶段 1：构建前端 =====
FROM node:20-alpine AS builder
WORKDIR /build

# 启用 pnpm 9（与项目 packageManager 字段一致）
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# 先拷 lockfile 走 Docker 缓存层（代码改了不重装依赖）
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

# 装依赖（冻结 lockfile，确保环境一致）
RUN pnpm install --frozen-lockfile

# 再拷源码
COPY base-elements ./base-elements
COPY apps/web ./apps/web

# 跑构建（产物在 apps/web/dist，含 copy-svgs.mjs 复制 SVG）
RUN pnpm --filter web build

# ===== 阶段 2：运行 Node 服务器（支持 scenarios 读写） =====
FROM node:20-alpine
LABEL maintainer="pv-ac-sim"
WORKDIR /app

# 拷贝构建产物 + 生产服务器脚本
COPY --from=builder /build/apps/web/dist ./dist
COPY --from=builder /build/apps/web/scripts/serve-prod.mjs ./scripts/serve-prod.mjs
COPY --from=builder /build/apps/web/scripts/realtime/contract.mjs /build/apps/web/scripts/realtime/auth.mjs /build/apps/web/scripts/realtime/state.mjs /build/apps/web/scripts/realtime/routes.mjs ./scripts/realtime/

# 场景目录（挂 volume 持久化）；使用内置 node 用户运行，避免 root 写宿主机。
RUN mkdir -p /app/scenarios && chown node:node /app/scenarios
ENV SCENARIOS_DIR=/app/scenarios
ENV PORT=8080
ENV NODE_ENV=production

# 暴露非特权端口
EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=2m --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/health || exit 1

# 启动 Node 服务器
USER node
CMD ["node", "scripts/serve-prod.mjs"]
