# HeyAgent 控制台镜像：构建 apps/web，用 Caddy 提供静态文件，/api 反向代理到 pod 里的 api。
# 在仓库根目录构建：podman build -f deploy/web.Containerfile -t heyagent-web .

# ---------- 构建：pnpm 装依赖，构建 apps/web ----------
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /repo
RUN npm install -g --fetch-timeout=600000 --fetch-retries=6 pnpm@11.23.0 && pnpm --version

# 可选的宿主机 pnpm store，同 deploy/api.Containerfile
ARG PNPM_STORE=

# 先只拷依赖清单，依赖没变时这一层可以复用。
# web 的 tsc 会顺带检查 shared 和 server 的源码（用 @heyagent/source 条件直接引用，路由类型来自 server），所以它们的依赖也要装
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --fetch-timeout=600000 --fetch-retries=6 --network-concurrency=4 \
      ${PNPM_STORE:+--store-dir "$PNPM_STORE" --prefer-offline --package-import-method copy} \
      --filter "@heyagent/web..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @heyagent/web build

# ---------- 运行：Caddy ----------
FROM docker.io/library/caddy:2.11.7-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
EXPOSE 8080
