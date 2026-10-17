# HeyAgent worker 镜像（agent 引擎 + 浏览器）。以浏览器基础镜像为底（用里面的 Chrome、Xvfb、gost）。
# M2：Playwright MCP 和 playwright-core 用的是 apps/server 依赖里按 pnpm lockfile 装的那份（/app/node_modules），
# 不再用基础镜像里 npm 装的 /opt/browser（那份的传递依赖没锁）。
# 在仓库根目录构建（先构建好 localhost/heyagent-browser-base:m0）：
#   podman build -f deploy/worker.Containerfile -t localhost/heyagent-worker:m1 .   （scripts/pod.sh up 会自动构建）
# 运行时要的环境变量同 API（.env.example）：DATABASE_URL、HEYAGENT_KEK_FILE（整套 pod 里是卷里 0400 的文件）；
# 另有 HEYAGENT_FILES_DIR（文件卷，和 API 挂同一个），可选 HEYAGENT_WORKER_CONCURRENCY 等（见 src/worker.ts）；
# HEYAGENT_BROWSER_CONTROL_PORT：浏览器内部控制接口（只绑 127.0.0.1，API 经它开 Chrome 登录、转发远程画面），默认 3190。
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
    HEYAGENT_FILES_DIR=/data/files \
    HEYAGENT_BROWSER_CONTROL_PORT=3190
USER root
RUN mkdir -p /data/files && chown browser:browser /data/files
# Chrome 的企业策略：关掉组件更新、同步、浏览器登录、搜索建议、预取等后台联网（m2.md 第 2 条：省代理流量）。
# 实测（经测试 SOCKS5 上游计数，打开 example.com 并空闲 12 秒）：只加启动参数时连 9 个 Google 相关主机、18 次；
# 加上策略后 6 个、约 10 次，组件下载（edgedl.me.gvt1.com，流量大头）没有了。剩下的是扩展更新检查、GCM 等小请求，参数和策略都关不掉。
COPY deploy/chrome-policy.json /etc/opt/chrome/policies/managed/heyagent.json
RUN chmod 0644 /etc/opt/chrome/policies/managed/heyagent.json
USER browser
WORKDIR /app
COPY --from=build --chown=browser:browser /out ./
CMD ["node", "dist/worker.js"]
