# 文案处理沙盒环境
#
# 用途：Markdown/JSON/CSV 的读写与校验。无重依赖，因此镜像刻意做到最小。
#
# 注意 FROM 必须写完整镜像源前缀（本机 registry-mirrors 对短名不生效）。

FROM docker.m.daocloud.io/library/node:22-alpine

# node:22-alpine 已内置 `node` 用户（uid/gid 1000），直接用。
# 该 uid 与 DockerSandbox 的 `User: '1000:1000'` 一致。

# 文案环境只需要 node；装上 jq 便于结构化文本校验，体积很小。
RUN apk add --no-cache jq

RUN mkdir -p /workspace/drafts /workspace/artifacts /workspace/logs \
 && chown -R node:node /workspace

ENV CI=1 \
    NODE_ENV=production \
    SANDBOX_ENV_TYPE=copy

USER node
WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node --version || exit 1

CMD ["node", "--version"]
