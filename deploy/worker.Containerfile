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

# ---------- 运行代码的沙箱的根文件系统（docs/dev/session-space.md 4.4）----------
# 独立的 Debian：Python 3.12 + 常用包、Node 24（带 npm）、bash、coreutils、jq、curl、socat（把出网代理的 unix socket 转成 127.0.0.1:3128）。
# 整个复制到运行镜像的 /opt/sandbox-root，沙箱（bubblewrap）只读挂成 /。/workspace、/home/sandbox 是挂载点。
FROM docker.io/library/python:3.12-slim-bookworm AS sandbox
RUN pip install --no-cache-dir --disable-pip-version-check \
      pandas==3.0.6 numpy==2.5.3 openpyxl==3.1.5 xlrd==2.0.2 python-dateutil==2.9.0.post0 \
      requests==2.34.2 beautifulsoup4==4.15.0 lxml==6.1.3 \
 && apt-get update \
 && apt-get install -y --no-install-recommends jq socat curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/library/node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=docker.io/library/node:24-bookworm-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && mkdir -p /workspace /home/sandbox \
 && node --version && npm --version \
 && python3 -c "import pandas, numpy, openpyxl, xlrd, dateutil, requests, bs4, lxml; print('python packages ok')"

# ---------- 运行：浏览器基础镜像（Ubuntu 24.04 + Chrome + Node 24），用户 browser（uid 1000） ----------
FROM localhost/heyagent-browser-base:m0
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HEYAGENT_FILES_DIR=/data/files \
    HEYAGENT_BROWSER_CONTROL_PORT=3190
USER root
RUN mkdir -p /data/files && chown browser:browser /data/files
# 运行代码的沙箱：bubblewrap（setpriv 在基础镜像的 util-linux 里）+ 独立的根文件系统。
# 不给 worker 加任何权限（pod.yaml 的 securityContext 不用改）：bwrap 用的是非特权的用户命名空间
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && bwrap --version && setpriv --version
COPY --from=sandbox / /opt/sandbox-root/
# Chrome 的企业策略：关掉组件更新、同步、浏览器登录、搜索建议、预取等后台联网（m2.md 第 2 条：省代理流量）。
# 实测（经测试 SOCKS5 上游计数，打开 example.com 并空闲 12 秒）：只加启动参数时连 9 个 Google 相关主机、18 次；
# 加上策略后 6 个、约 10 次，组件下载（edgedl.me.gvt1.com，流量大头）没有了。剩下的是扩展更新检查、GCM 等小请求，参数和策略都关不掉。
COPY deploy/chrome-policy.json /etc/opt/chrome/policies/managed/heyagent.json
RUN chmod 0644 /etc/opt/chrome/policies/managed/heyagent.json
USER browser
WORKDIR /app
COPY --from=build --chown=browser:browser /out ./
CMD ["node", "dist/worker.js"]
