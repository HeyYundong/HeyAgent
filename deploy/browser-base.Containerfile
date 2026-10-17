# HeyAgent 浏览器基础镜像（M0 包 2）
#
# 内容：Ubuntu 24.04 + Google Chrome 正式版（有界面，配 Xvfb）+ 中文 / emoji 字体 + tzdata
#       + gost v3（带认证 SOCKS5 的本地转发）+ Node 24 + @playwright/mcp 0.0.83 + playwright-core 1.64.1
# 用途：browser-runner 镜像（M2）以它为底；M0 只用于实测，见 docs/research/m0-browser-spike.md。
#
# 构建（不需要构建上下文里的任何文件，用 deploy/ 当上下文即可）：
#   podman build -f deploy/browser-base.Containerfile -t localhost/heyagent-browser-base:m0 deploy/
#
# 推荐的运行参数（实测过，理由见报告）：
#   podman run --init --shm-size=2g \
#     --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT ...
#   Chrome 的 sandbox（user namespace + seccomp-bpf）在 rootless Podman 3.4.4 的默认 seccomp 下就能开，
#   不需要 --no-sandbox，也不需要额外的 seccomp 配置；只是不能把 SYS_CHROOT 也去掉。
#
# 所有下载都固定版本并校验 sha256。升级时三处一起改：版本号、sha256、报告里的来源说明。
#   - Chrome：dl.google.com 的 apt 仓库 pool 里的固定版本 .deb。sha256 取自仓库的 Packages 文件，
#     Packages 的 sha256 又由 InRelease 签名保证（Google Linux 签名主钥 EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796）。
#   - gost：GitHub go-gost/gost 正式 release 的 linux_amd64 包，sha256 与 release 里的 checksums.txt、GitHub 资产摘要一致。
#   - Node：nodejs.org 官方 tarball，sha256 取自 SHASUMS256.txt.asc（Node 发布人 Richard Lau 的密钥签名，
#     指纹 C82F A3AE 1CBE DC6B E46B 9360 C43C EC45 C17A B93C，在 nodejs/node README 的发布人列表里）。

# ---- fetch 阶段：下载并校验 Node 和 gost ----
# 为什么单独用 22.04 解包：开发机 rootless Podman 3.4.4 配的 crun 0.17 不认 seccomp 的 defaultErrnoRet，
# 内核不认识的新系统调用（fchmodat2）在容器里返回 EPERM 而不是 ENOSYS。24.04 的 glibc 2.39 + tar 1.35
# 解包时会用 fchmodat2，拿到 EPERM 就不回退，直接失败；22.04 的 glibc 2.35 不用这个调用。
FROM docker.io/library/ubuntu:22.04 AS fetch
ARG GOST_VERSION=3.3.0
ARG GOST_SHA256=676fb7f78d267b6ae73df719c0c7f2b565dde7147da935cfafbc1e1da558b6d5
ARG NODE_VERSION=24.22.0
ARG NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out/node \
 && curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /out/node --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/share/doc' --exclude='*/include' \
 && curl -fsSL -o /tmp/gost.tar.gz "https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_amd64.tar.gz" \
 && echo "${GOST_SHA256}  /tmp/gost.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gost.tar.gz -C /out --no-same-owner gost

# ---- 正式镜像 ----
FROM docker.io/library/ubuntu:24.04

ARG CHROME_VERSION=155.0.8059.84-1
ARG CHROME_SHA256=8fbd2ae69cdf7ee98b7513c3396a7b5e06f974f8625fdd590df3091dd0c3e9de

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 系统包 + Chrome。Chrome 的依赖（libnss3 等）由 apt 按 .deb 的 Depends 自动装。
# Chrome 的 postinst 会写 apt 源和 cron，删掉 apt 源：镜像里的 Chrome 版本只由上面的 ARG 决定，不跟着 apt upgrade 走。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      xvfb xauth \
      fonts-noto-cjk fonts-noto-color-emoji \
      tzdata \
 && curl -fsSL -o /tmp/chrome.deb \
      "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
 && echo "${CHROME_SHA256}  /tmp/chrome.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list /etc/cron.daily/google-chrome \
 && rm -rf /var/lib/apt/lists/*

# Node 24 和 gost：在 fetch 阶段下载、校验、解包，再整目录拷进来（见文件开头 fetch 阶段的说明）。
COPY --from=fetch /out/node/ /usr/local/
COPY --from=fetch /out/gost /usr/local/bin/gost
RUN node --version && gost -V

# Playwright MCP + playwright-core，装在 /opt/browser。
# runner 的代码放在 /opt/browser 下面（或子目录）时，import "playwright-core" 会往上找到这里的 node_modules。
# 注意：@playwright/mcp 0.0.83 自带一份 1.64.0-alpha 的 playwright / playwright-core（它的精确依赖），和顶层的 1.64.1 并存。
# 传递依赖没有锁文件锁定；M2 做 runner 镜像时改成 pnpm lockfile 安装。
RUN mkdir -p /opt/browser \
 && cd /opt/browser \
 && printf '{"name":"heyagent-browser-base","private":true,"type":"module"}\n' > package.json \
 && npm install --save-exact --omit=dev --no-fund --no-audit --no-update-notifier \
      @playwright/mcp@0.0.83 playwright-core@1.64.1 \
 && npm cache clean --force \
 && ln -s /opt/browser/node_modules/.bin/playwright-mcp /usr/local/bin/playwright-mcp

# 非 root 用户。基础镜像自带的 ubuntu 用户占着 1000，删掉后用同一个 uid，
# 这样实测时 --userns=keep-id 挂进来的目录读写权限对得上；生产不依赖 keep-id。
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash browser

ENV CHROME_BIN=/opt/google/chrome/chrome
USER browser
WORKDIR /home/browser
CMD ["bash"]
