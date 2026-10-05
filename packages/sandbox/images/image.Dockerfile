# 图像处理沙盒环境
#
# 用途：Pillow/numpy 图像处理，ffmpeg 视频处理，产物输出到 /workspace/artifacts。
#
# 注意 FROM 必须写完整镜像源前缀（本机 registry-mirrors 对短名不生效）。

FROM docker.m.daocloud.io/library/python:3.12-slim

# 沙盒内以非 root 用户运行。
RUN groupadd -g 1000 sandbox \
 && useradd -u 1000 -g sandbox -m -s /bin/bash sandbox

# ffmpeg 用于视频处理；本机宿主没有 ffmpeg，容器里必须有，否则视频类工具无法工作。
# 换国内 apt 源以加速（debian 官方源在国内很慢）。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Python 依赖走国内镜像源。
# Pillow 用于图像，numpy 用于数值处理。
RUN pip install --no-cache-dir \
      -i https://pypi.tuna.tsinghua.edu.cn/simple \
      Pillow==11.0.0 \
      numpy==2.1.3

RUN mkdir -p /workspace/in /workspace/out /workspace/artifacts /workspace/logs \
 && chown -R sandbox:sandbox /workspace

ENV PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLBACKEND=Agg \
    SANDBOX_ENV_TYPE=image

USER sandbox
WORKDIR /workspace

# 健康检查：确认 python 与 PIL 真的可用。
# 本机宿主的 `python` 是 WindowsApps 存根（假壳），容器内必须是真的解释器。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import PIL, numpy" || exit 1

CMD ["python", "--version"]
