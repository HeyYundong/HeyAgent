# HeyAgent worker 镜像（agent 引擎）。以浏览器基础镜像为底（M2 要用里面的 Chrome、Xvfb、gost、Playwright MCP）。
# 在仓库根目录构建（先构建好 localhost/heyagent-browser-base:m0）：
#   podman build -f deploy/worker.Containerfile -t localhost/heyagent-worker:m1 .   （scripts/pod.sh up 会自动构建）
# 运行时要的环境变量同 API（.env.example）：DATABASE_URL、HEYAGENT_KEK_FILE（整套 pod 里是卷里 0400 的文件）；
# 另有 HEYAGENT_FILES_DIR（文件卷，和 API 挂同一个），可选 HEYAGENT_WORKER_CONCURRENCY 等（见 src/worker.ts）。
# 数据库迁移由 API 容器启动时执行，worker 不跑迁移：pod 里 worker 等 API 健康了再起（deploy/pod.yaml）。

# ---------- 构建：和 API 镜像同一套步骤 ----------
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@11.23.0 && pnpm --version

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

# ---------- 运行：浏览器基础镜像（Ubuntu 24.04 + Chrome + Node 24），用户 browser（uid 1000） ----------
FROM localhost/heyagent-browser-base:m0
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HEYAGENT_FILES_DIR=/data/files
USER root
RUN mkdir -p /data/files && chown browser:browser /data/files
USER browser
WORKDIR /app
COPY --from=build --chown=browser:browser /out ./
CMD ["node", "dist/worker.js"]
