# HeyAgent API 镜像。在仓库根目录构建：podman build -f deploy/api.Containerfile -t heyagent-api .
# 运行时要的环境变量见 .env.example；主密钥文件用 Podman secret 挂进来，HEYAGENT_KEK_FILE 指向它。

# ---------- 构建：pnpm 装依赖，构建 shared 和 server ----------
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /repo
# 网络慢时多等、多重试（默认 60 秒就放弃一个包）
RUN npm install -g --fetch-timeout=600000 --fetch-retries=6 pnpm@11.23.0 && pnpm --version

# 可选：用宿主机现成的 pnpm store。scripts/pod.sh 设了 HEYAGENT_PNPM_STORE 时把它挂到 /pnpm-store 并传 PNPM_STORE=/pnpm-store，
# 本机有的包不再下载，缺的照旧从官方源下。用 copy 导入：镜像里不能留指向挂载目录的硬链接。不传时和以前一样
ARG PNPM_STORE=

# 先只拷依赖清单，依赖没变时这一层可以复用
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --fetch-timeout=600000 --fetch-retries=6 --network-concurrency=4 \
      ${PNPM_STORE:+--store-dir "$PNPM_STORE" --prefer-offline --package-import-method copy} \
      --filter "@heyagent/server..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @heyagent/shared build \
 && pnpm --filter @heyagent/server build \
 && pnpm --filter @heyagent/server deploy --prod --legacy --fetch-timeout=600000 --fetch-retries=6 --network-concurrency=4 \
      ${PNPM_STORE:+--store-dir "$PNPM_STORE" --prefer-offline --package-import-method copy} /out

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
