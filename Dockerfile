# ---- build ----
# 注意：服务器 Docker 镜像源（xuanyuan.me）对 docker.io 返回 403，
# 因此使用服务器上已存在的 node:lts-alpine3.23。
FROM node:lts-alpine3.23 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# ---- runtime ----
FROM node:lts-alpine3.23
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --registry=https://registry.npmmirror.com \
    && pnpm store prune
COPY --from=build /app/dist ./dist

# 以非 root 运行
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
