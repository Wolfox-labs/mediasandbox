# 前端沙盒环境
#
# 用途：脚手架、依赖安装、构建，产物输出到 /workspace/artifacts。
#
# 注意 FROM 必须写完整镜像源前缀：本机 registry-mirrors 对短名不生效，
# 直接写 `node:22-alpine` 会去 registry-1.docker.io 拉取而超时。

FROM docker.m.daocloud.io/library/node:22-alpine

# node:22-alpine 已内置 `node` 用户，uid/gid 均为 1000。
# 直接用它，不另建用户——同 gid 冲突会导致 addgroup 失败。
# 该 uid 与 DockerSandbox 里的 `User: '1000:1000'` 一致。

# 构建期换国内镜像源；运行期不需要联网。
# 必须用 -g：不以 -g 时写的是 root 的 ~/.npmrc，而容器以 node 用户运行，
# 那份配置根本读不到。
RUN npm config set -g registry https://registry.npmmirror.com \
 && npm config set -g fund false \
 && npm config set -g audit false \
 && npm config set -g update-notifier false \
 && npm config set -g cache /home/node/.npm

# 沙盒工作区。执行器把宿主机目录挂载到这里。
RUN mkdir -p /workspace/src /workspace/artifacts /workspace/logs /home/node/.npm \
 && chown -R node:node /workspace /home/node

# 基线环境变量（与本地 provider 的 env-presets 保持一致）。
ENV NODE_ENV=development \
    CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PYTHONIOENCODING=utf-8 \
    SANDBOX_ENV_TYPE=frontend

USER node
WORKDIR /workspace

# 健康检查：确认 node 真的可用（而不只是个壳）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node --version || exit 1

CMD ["node", "--version"]
