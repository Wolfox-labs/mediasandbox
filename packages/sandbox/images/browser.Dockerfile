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

# apk 换国内源。默认的 dl-cdn.alpinelinux.org 在本机实测慢到拉不动
# （一次构建挂了二十分钟还停在下载阶段）。
#
# 这里用**清华**而不是阿里云，是量出来的结论：同一个 51MB 的 llvm17-libs
# （chromium 依赖 mesa，mesa 依赖 llvm），
#   阿里云 25 秒只下来 2.3MB（约 93 KB/s，实际是挂住），
#   清华同一条文件跑满 10 MB/s。
# 换源前两次构建都**恰好卡在这个包**上，不是巧合。
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.tuna.tsinghua.edu.cn#g' /etc/apk/repositories

# chromium —— 渲染。
#
# 为什么和字体**分两层**：这层要拉 170 个包（含 mesa / llvm，几百 MB），
# 分层的意义是——一层卡住时，已经装好的那层留在缓存里，重试不用从头再来。
# `--timeout 60` 让卡死的连接自己断掉报错，而不是无声地挂着。
RUN apk add --no-cache --timeout 60 chromium

# font-noto-cjk —— **中文必须要有字体**，否则整页中文会渲染成一排方框，
#                  而这种"截图成功了、但全是豆腐块"最难被发现。
RUN apk add --no-cache --timeout 60 font-noto-cjk

# socat —— 给"模拟点击"用：新版 chromium 的 DevTools 只肯监听容器内的 127.0.0.1
# （`--remote-debugging-address` 已被忽略，实测仍绑 127.0.0.1），
# 而端口要从宿主机经 Docker 代理进来，够不着那个回环地址。
# 于是在容器内做一层转发：0.0.0.0:<对外端口> → 127.0.0.1:9222。
# 宿主机侧只发布 `127.0.0.1:<随机端口>`，局域网里别的机器连不上。
RUN apk add --no-cache --timeout 60 socat

RUN mkdir -p /workspace \
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
