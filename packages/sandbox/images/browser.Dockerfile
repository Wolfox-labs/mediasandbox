# 浏览器镜像：给「页面截图」用。
#
# 与三个环境镜像（frontend / image / copy）不是一回事：它**不承载项目工作区**，
# 而是被截图驱动当作**旁挂容器**起一次——挂载项目工作区、渲染 `file://` 页面、
# 把 PNG 写回去，然后退出。
#
# 为什么不做进项目镜像里：网页产物只需要 node，把几百 MB 的 chromium 塞进每个
# 项目容器不划算；旁挂容器的隔离边界与项目容器同级（同样 network=none、
# CapDrop ALL、只读根），不会因为"要截图"就破一次口。
#
# FROM 必须写完整镜像源前缀：本机实测 `registry-mirrors` 对短名不生效，
# 写 `alpine:3.20` 会去 registry-1.docker.io 直连并超时。
FROM docker.m.daocloud.io/library/alpine:3.20

# chromium —— 渲染；
# font-noto-cjk —— **中文必须要有字体**，否则整页中文会渲染成一排方框，
#                  而这种"截图成功了、但全是豆腐块"最难被发现。
RUN apk add --no-cache chromium font-noto-cjk ttf-freefont \
 && mkdir -p /workspace \
 && adduser -D -u 1000 shooter \
 && chown -R shooter:shooter /workspace

# 以非 root 跑：工作区是挂进来的，它只需要往 /workspace 写那一张图。
USER shooter
WORKDIR /workspace

# 健康检查：确认 chromium 真的在（而不只是个壳）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /usr/bin/chromium-browser --version || exit 1

# 默认什么都不做：命令由截图驱动给。
CMD ["/bin/true"]
