# HeyAgent API 镜像。在仓库根目录构建：podman build -f deploy/api.Containerfile -t heyagent-api .
# 运行时要的环境变量见 .env.example；主密钥文件用 Podman secret 挂进来，HEYAGENT_KEK_FILE 指向它。

# ---------- 构建：pnpm 装依赖，构建 shared 和 server ----------
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@11.23.0 && pnpm --version

# 先只拷依赖清单，依赖没变时这一层可以复用
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@heyagent/server..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @heyagent/shared build \
 && pnpm --filter @heyagent/server build \
 && pnpm --filter @heyagent/server deploy --prod --legacy /out

# ---------- 运行：Node 24 ----------
FROM docker.io/library/node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node deploy/api-entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 3100
CMD ["./entrypoint.sh"]
