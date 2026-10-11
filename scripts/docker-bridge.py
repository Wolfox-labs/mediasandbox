"""Docker API -> docker CLI 桥：让 Low 完整性进程也能用 Docker（Windows）。

## 为什么需要这个东西

本机（Windows + DSH）有个硬约束：

  * DSH 的工具进程跑在 **Low 完整性**，它派生的子进程也是 Low（实测 python 起 node 仍是 Low）；
  * Windows 强制完整性控制（MIC）禁止 Low 进程打开 Docker Desktop 的命名管道：
        node -> //./pipe/docker_engine   EPERM
  * 但 `docker.exe` 是原生程序（Medium 完整性），**什么都能干**；
  * TCP 环回不受 MIC 约束。

于是：让 python 在 127.0.0.1 上起一个**极小的 Docker API 服务**，把收到的 API 请求
翻译成 `docker` CLI 调用。node/dockerode 只要 `DOCKER_HOST=tcp://127.0.0.1:2375`
就能拿到完整的容器能力。

> 曾试过"TCP -> 命名管道"裸转发，行不通：`open(pipe, "rb")` 报 `Invalid argument`
> （Docker 的管道只接受 `r+b`），而 `r+b` 的 `_io.FileIO` 读不出响应（实测一直阻塞）。
> 走 `docker.exe` 反而确定：它自己怎么连上的，我们不用管。

## 实现了哪些接口（只做项目实际用到的，不做通用代理）

  GET    /_ping                             -> OK
  GET    /version                           -> docker version
  GET    /info                              -> docker info
  GET    /containers/json                   -> docker ps（含过滤与 limit）
  POST   /containers/create                 -> docker create
  POST   /containers/{id}/start             -> docker start
  POST   /containers/{id}/wait              -> 轮询 docker inspect 直到退出
  GET    /containers/{id}/json              -> docker inspect
  DELETE /containers/{id}                   -> docker rm（force/v 由查询串决定）
  POST   /containers/{id}/stop              -> docker stop
  GET    /images/json                       -> docker images
  GET    /images/{name}/json                -> docker image inspect
  POST   /images/create                     -> docker pull（回一个 NDJSON 流）
  POST   /containers/{id}/exec              -> 记下命令，返回占位 Id
  POST   /exec/{id}/start                   -> docker exec（流式输出）
  GET    /exec/{id}/json                    -> ExitCode

## 安全边界（务必读完）

它把**本机的 Docker 最高权限**暴露给任何能连到这个端口的进程。所以：
只绑 127.0.0.1、**绝不绑 0.0.0.0**、用完就关。它不校验请求方身份。

  python scripts/docker-bridge.py [--port 2375]
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOCKER = "docker"
EXEC_SESSION_TTL = 600.0

# execId -> {"container": id, "cmd": [...], "exit": int|None}
EXEC_SESSIONS: dict[str, dict] = {}
EXEC_LOCK = threading.Lock()


def docker_run(args: list[str], timeout: float = 120.0) -> tuple[int, str, str]:
    """跑一条 docker 命令。返回 (returncode, stdout, stderr)。"""
    try:
        result = subprocess.run(
            [DOCKER, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"docker {' '.join(args)} 超时（{timeout}s）"
    except OSError as error:
        return 127, "", f"无法执行 docker：{error}"


def docker_json(args: list[str], timeout: float = 120.0):
    """跑一条 `docker ... --format {{json .}}` 并解析每行 JSON。"""
    code, out, err = docker_run(args, timeout)
    if code != 0:
        return None, err
    items = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            items.append({"raw": line})
    return items, None


def parse_size(value: str) -> int:
    """把 `1.09GB` / `927MB` / `12.2MB` 这类尺寸解析成字节。"""
    match = re.match(r"^\s*([\d.]+)\s*([kKMGT]?)(i?B)?\s*$", value or "")
    if not match:
        return 0
    number = float(match.group(1))
    unit = (match.group(2) or "").upper()
    factor = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}.get(unit, 1)
    return int(number * factor)


def parse_created(value) -> int:
    """`docker ps` 的 CreatedAt 是 '2026-10-11 14:37:28 +0800 CST'，转成 unix 秒。"""
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S %z %Z", "%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(time.mktime(time.strptime(text[: len(fmt) + 6], fmt)))
        except ValueError:
            continue
    return int(time.time())


class Bridge(BaseHTTPRequestHandler):
    # 每请求一连接，**故意**不用 HTTP/1.1 keep-alive。
    #
    # 原因（实测）：dockerode 在 hijack 模式下发完 `exec start` 的 body 后，
    # 连接上会留下未读残渣，下一个请求行就变成
    #   `{"hijack":true,"stdin":false}GET /exec/xxx/json`
    # 也就是 body 与请求行粘在一起，服务器报 501 Unsupported method。
    # 关掉长连接后每个请求都是干净的 socket，这个粘包问题从根上消失。
    # 代价是每请求一次 TCP 握手——本地回环，可忽略。
    protocol_version = "HTTP/1.0"
    server_version = "dsh-docker-bridge/1.0"

    # ── 基础工具 ────────────────────────────────────────────────────────
    def log_message(self, fmt, *args):  # noqa: A003 - 基类签名
        return

    def handle_expect_100(self) -> bool:
        """响应 `Expect: 100-continue`。

        必须实现：dockerode 在 `exec start`（hijack 模式）时会带这个头，
        并**等我们回 100 才发 body**。BaseHTTPRequestHandler 默认直接回 501，
        结果 body 永远不到、请求头被粘进方法名里，报
        `Unsupported method ('{"hijack":true,...}GET')`——实测就是这么炸的。
        """
        self.send_response_only(100)
        self.end_headers()
        return True

    def handle_one_request(self) -> None:
        """接线级抓包：只在请求行不合法时把原始字节打出来。

        没有这段就只能对着 `Unsupported method (...)` 猜——HTTP 库会把不合法的
        请求行原样塞进 method，光看错误文本分不清是客户端发错、还是我们读串了。
        """
        try:
            super().handle_one_request()
        except Exception as error:  # noqa: BLE001 - 桥不能因单请求崩掉
            print(f"[bridge] handle_one_request 异常: {type(error).__name__}: {error}", flush=True)
            raise
        if self.command and self.command not in (
            "GET",
            "POST",
            "PUT",
            "DELETE",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "CONNECT",
            "TRACE",
        ):
            print(f"[bridge] 非法请求行，method={self.command!r} path={self.path!r}", flush=True)

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def read_json(self) -> dict:
        raw = self.read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 500) -> None:
        self.send_json({"message": message}, status)

    def send_text(self, text: str, status: int = 200, content_type: str = "text/plain") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream_chunks(self, chunks) -> None:
        """以 HTTP/1.1 chunked 写出一个流（dockerode 会当 NDJSON 流读）。"""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for chunk in chunks:
            data = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
            if not data:
                continue
            try:
                self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                self.wfile.write(data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        self.wfile.write(b"0\r\n\r\n")

    # ── 路由 ────────────────────────────────────────────────────────────
    def do_GET(self):  # noqa: N802 - 基类命名
        self.route("GET")

    def do_POST(self):  # noqa: N802
        self.route("POST")

    def do_DELETE(self):  # noqa: N802
        self.route("DELETE")

    def do_HEAD(self):  # noqa: N802
        self.route("HEAD")

    def route(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        # dockerode 会带 /v1.xx 前缀。
        path = re.sub(r"^/v[\d.]+", "", path)
        self.log_request_line(method, path)

        try:
            self.dispatch(method, path, query)
        except Exception as error:  # noqa: BLE001 - 桥要保证不因单请求崩掉
            self.send_error_json(f"{type(error).__name__}: {error}", 500)

    def log_request_line(self, method: str, path: str) -> None:
        """打印每条请求。

        没有这个就只能猜"调用方到底问了什么"——排查截图链路时，探针一直报
        "文件不存在"，而桥这边一条日志都没有，才看清是它压根没走桥。
        """
        print(f"[bridge] {method} {path}", flush=True)

    def dispatch(self, method: str, path: str, query: dict) -> None:
        if path in ("/_ping", "/ping"):
            # 必须是 body 恰为 `OK` 且带 API-Version 头：docker.exe 会对长连接里
            # 的杂散响应报 "Unsolicited response received on idle HTTP channel"。
            body = b"OK"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Api-Version", "1.43")
            self.send_header("Docker-Experimental", "false")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(body)
            return
        if path == "/version":
            code, out, _ = docker_run(["version", "--format", "{{json .}}"])
            if code != 0:
                return self.send_error_json("docker version 失败")
            lines = [json.loads(line) for line in out.splitlines() if line.strip()]
            merged = {}
            for line in lines:
                merged.update(line)
            return self.send_json(merged)
        if path == "/info":
            items, err = docker_json(["info", "--format", "{{json .}}"])
            if items is None or not items:
                return self.send_error_json(err or "docker info 失败")
            return self.send_json(items[0])

        if path == "/containers/json" and method == "GET":
            return self.containers_json(query)
        if path == "/images/json" and method == "GET":
            return self.images_json()
        if path == "/images/create" and method == "POST":
            return self.images_create(query)
        if path == "/containers/create" and method == "POST":
            return self.container_create()

        match = re.match(r"^/containers/([^/]+)/(json|start|wait|stop|kill|restart)$", path)
        if match:
            return self.container_action(match.group(1), match.group(2), method)
        match = re.match(r"^/containers/([^/]+)$", path)
        if match and method == "DELETE":
            return self.container_remove(match.group(1), query)
        match = re.match(r"^/containers/([^/]+)/exec$", path)
        if match and method == "POST":
            return self.container_exec(match.group(1))
        match = re.match(r"^/exec/([^/]+)/(start|json|resize)$", path)
        if match:
            return self.exec_action(match.group(1), match.group(2), method)
        match = re.match(r"^/images/(.+)/json$", path)
        if match and method == "GET":
            return self.image_inspect(urllib.parse.unquote(match.group(1)))

        self.send_error_json(f"桥未实现该接口：{method} {path}", 404)

    # ── 各接口实现 ──────────────────────────────────────────────────────
    def containers_json(self, query: dict) -> None:
        args = ["ps", "--format", "{{json .}}"]
        if (query.get("all") or ["0"])[0] not in ("0", "false", ""):
            args.append("-a")
        for raw in query.get("filters", []):
            try:
                filters = json.loads(raw)
            except json.JSONDecodeError:
                continue
            for key, values in (filters or {}).items():
                if key in ("label", "name", "status", "id"):
                    for value in values if isinstance(values, list) else [values]:
                        flag = {"label": "-f", "name": "-f", "status": "-f", "id": "-f"}[key]
                        prefix = {"label": "label=", "name": "name=", "status": "status=", "id": "id="}[key]
                        args += [flag, f"{prefix}{value}"]
        limit = (query.get("limit") or [None])[0]
        if limit and limit.isdigit():
            args += ["-n", limit]

        items, err = docker_json(args)
        if items is None:
            return self.send_error_json(err or "docker ps 失败")
        out = []
        for item in items:
            labels = {}
            for pair in (item.get("Labels") or "").split(","):
                if "=" in pair:
                    key, _, value = pair.partition("=")
                    labels[key] = value
            out.append(
                {
                    "Id": item.get("ID"),
                    "Names": [item.get("Names")] if item.get("Names") else [],
                    "Image": item.get("Image"),
                    "State": (item.get("State") or "").lower(),
                    "Status": item.get("Status"),
                    "Labels": labels,
                    "Created": parse_created(item.get("CreatedAt")),
                }
            )
        self.send_json(out)

    def images_json(self) -> None:
        items, err = docker_json(
            ["images", "--format", "{{json .}}", "--no-trunc"]
        )
        if items is None:
            return self.send_error_json(err or "docker images 失败")
        out = []
        for item in items:
            repo = item.get("Repository") or "<none>"
            tag = item.get("Tag") or "<none>"
            out.append(
                {
                    "Id": item.get("ID"),
                    "RepoTags": [] if repo == "<none>" else [f"{repo}:{tag}"],
                    "Size": parse_size(item.get("Size")),
                    "Created": parse_created(item.get("CreatedAt")),
                }
            )
        self.send_json(out)

    def images_create(self, query: dict) -> None:
        image = (query.get("fromImage") or [""])[0]
        tag = (query.get("tag") or [""])[0]
        if not image:
            return self.send_error_json("缺少 fromImage", 400)
        reference = f"{image}:{tag}" if tag else image

        def chunks():
            code, out, err = docker_run(["pull", reference], timeout=1800)
            for line in out.splitlines():
                yield json.dumps({"status": line}, ensure_ascii=False) + "\n"
            if code != 0:
                yield json.dumps({"error": err.strip() or f"pull 失败 ({code})"}, ensure_ascii=False) + "\n"

        self.stream_chunks(chunks())

    def container_create(self) -> None:
        spec = self.read_json()
        name = spec.get("name") or spec.get("Name")
        image = spec.get("Image")
        if not image:
            return self.send_error_json("缺少 Image", 400)

        args = ["create", "--name", str(name) if name else f"ms-{int(time.time()*1000)}"]
        for key, value in (spec.get("Labels") or {}).items():
            args += ["--label", f"{key}={value}"]
        workdir = spec.get("WorkingDir")
        if workdir:
            args += ["--workdir", str(workdir)]
        # Env 必须转发：chromium 的截图容器靠 `HOME=/tmp` 才能在只读根下建 profile，
        # 少了它 chromium 以 133 退出、一张图都不写（见 chromium.ts 的注释与实测）。
        for pair in spec.get("Env") or []:
            args += ["--env", str(pair)]
        user = spec.get("User")
        if user:
            args += ["--user", str(user)]

        host = spec.get("HostConfig") or {}
        for bind in host.get("Binds") or []:
            args += ["--volume", str(bind)]
        network = host.get("NetworkMode")
        if network:
            args += ["--network", str(network)]
        memory = host.get("Memory")
        if memory:
            args += ["--memory", str(int(memory))]
        nano = host.get("NanoCpus")
        if nano:
            args += ["--cpus", f"{int(nano) / 1e9:g}"]
        pids = host.get("PidsLimit")
        if pids:
            args += ["--pids-limit", str(int(pids))]
        if host.get("ReadonlyRootfs"):
            args += ["--read-only"]
        for target, options in (host.get("Tmpfs") or {}).items():
            args += ["--tmpfs", f"{target}:{options}"]
        for capability in host.get("CapDrop") or []:
            args += ["--cap-drop", str(capability)]
        for option in host.get("SecurityOpt") or []:
            args += ["--security-opt", str(option)]

        # 端口暴露与映射：点击链路（chromium-click.ts）靠它把容器里的 CDP 调试端口
        # 映到宿主，再去连 127.0.0.1:<hostPort>。少了这段，驱动会一直等
        # "等不到 chromium 调试端口（9223）"。
        for port in (spec.get("ExposedPorts") or {}):
            args += ["--expose", str(port).split("/")[0]]
        for port, bindings in (host.get("PortBindings") or {}).items():
            container_port = str(port).split("/")[0]
            for binding in bindings or []:
                host_port = binding.get("HostPort") or ""
                host_ip = binding.get("HostIp") or "127.0.0.1"
                args += ["-p", f"{host_ip}:{host_port}:{container_port}" if host_port
                         else f"{host_ip}::{container_port}"]

        args.append(str(image))
        args += [str(part) for part in (spec.get("Cmd") or [])]

        try:
            code, out, err = docker_run(args, timeout=180)
            if code != 0:
                return self.send_error_json(f"docker create 失败：{err.strip()}", 500)
        except Exception as error:  # noqa: BLE001
            print(f"[bridge] create 异常: {type(error).__name__}: {error}", flush=True)
            raise
        # 打印真实执行的 docker create 参数：排查"容器跑完但宿主看不到产物"时，
        # 第一个要确认的就是挂载有没有真的传下去。
        print(f"[bridge] create: {' '.join(args[:2])} … "
              f"image={image} binds={host.get('Binds')} env={spec.get('Env')} "
              f"ports={host.get('PortBindings')}", flush=True)
        container_id = out.strip().splitlines()[-1] if out.strip() else ""
        self.send_json({"Id": container_id, "Warnings": []}, 201)

    def container_action(self, container_id: str, action: str, method: str) -> None:
        container_id = urllib.parse.unquote(container_id)
        if action == "json":
            # 用**原生** `docker inspect`（输出是一个 JSON 数组），而不是
            # `--format '{{json .}}'`：后者经过模板渲染，实测拿到的东西缺 State，
            # 解析失败时还会被兜成 {"raw": "..."}，最终把 Running/ExitCode 变成 null。
            # 原生格式的字段名与 Docker API 完全一致，dockerode 直接透传即可。
            code, out, err = docker_run(["inspect", container_id], timeout=60)
            if code != 0:
                return self.send_error_json(err.strip() or f"inspect {container_id} 失败", 404)
            try:
                items = json.loads(out)
            except json.JSONDecodeError as error:
                return self.send_error_json(f"docker inspect 输出无法解析：{error}", 500)
            if not items:
                return self.send_error_json(f"inspect {container_id} 没有结果", 404)
            return self.send_json(items[0])
        if action == "wait":
            # dockerode 的 wait() 期望一个流，每行一个 {"StatusCode": n}。
            # docker CLI 没有等价命令，所以轮询 inspect 直到容器退出。
            #
            # 退出码一旦取不到就**不能**兜成 0：调用方（chromium.ts）拿 0 当"渲染成功"，
            # 兜 0 会把"我们没读到状态"伪装成"渲染成功"，然后报一个莫名其妙的
            # "文件不存在"。取不到就明说。
            def chunks():
                started = time.time()
                deadline = started + 3600
                while time.time() < deadline:
                    state = self.inspect_state(container_id)
                    if state is None:
                        print(f"[bridge] wait: inspect {container_id[:12]} 读不到状态，继续等", flush=True)
                    elif state.get("Running") is not True:
                        # 必须是**明确的 False**才认为退出了：容器刚 start 的瞬间，
                        # Running 可能读到 None/缺失。之前用真值判断把它当成"已退出"，
                        # 于是立刻删容器把 chromium 杀在半路，还报"文件不存在"。
                        code = state.get("ExitCode")
                        if code is None:
                            print(f"[bridge] wait: {container_id[:12]} 已退出但 ExitCode 为空", flush=True)
                            yield json.dumps(
                                {"StatusCode": 1, "Error": {"Message": "inspect 没有给出 ExitCode"}}
                            ) + "\n"
                            return
                        print(
                            f"[bridge] wait: {container_id[:12]} 退出码 {code}，"
                            f"耗时 {time.time() - started:.1f}s",
                            flush=True,
                        )
                        yield json.dumps({"StatusCode": int(code)}) + "\n"
                        return
                    time.sleep(0.5)
                yield json.dumps({"StatusCode": 137, "Error": {"Message": "wait 超时"}}) + "\n"

            return self.stream_chunks(chunks())

        if method != "POST":
            return self.send_error_json(f"{action} 需要 POST", 405)
        command = {"start": "start", "stop": "stop", "kill": "kill", "restart": "restart"}[action]
        code, _, err = docker_run([command, container_id], timeout=120)
        if code != 0:
            return self.send_error_json(f"docker {command} 失败：{err.strip()}", 500)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def container_remove(self, container_id: str, query: dict) -> None:
        container_id = urllib.parse.unquote(container_id)
        args = ["rm"]
        if (query.get("force") or ["0"])[0] not in ("0", "false", ""):
            args.append("-f")
        if (query.get("v") or ["0"])[0] not in ("0", "false", ""):
            args.append("-v")
        args.append(container_id)
        code, _, err = docker_run(args, timeout=120)
        if code != 0:
            return self.send_error_json(f"docker rm 失败：{err.strip()}", 404)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def inspect_state(self, container_id: str) -> dict | None:
        """取容器的 `State` 字典；读不到就返回 None。

        统一用**原生** `docker inspect`（输出是 JSON 数组）。不要用
        `--format '{{json .}}'`：那条路径实测会丢字段，解析失败还会被兜成
        `{"raw": ...}`，让调用方把"读不到"误当成"已停止"。
        """
        code, out, err = docker_run(["inspect", container_id], timeout=60)
        if code != 0:
            return None
        try:
            items = json.loads(out)
        except json.JSONDecodeError:
            return None
        if not items:
            return None
        state = items[0].get("State")
        return state if isinstance(state, dict) else None

    def image_inspect(self, reference: str) -> None:
        code, out, err = docker_run(["image", "inspect", reference], timeout=60)
        if code != 0:
            return self.send_error_json(err.strip() or f"镜像不存在：{reference}", 404)
        try:
            items = json.loads(out)
        except json.JSONDecodeError:
            return self.send_error_json("docker image inspect 输出无法解析", 500)
        info = items[0] if items else {}
        info.setdefault("Size", 0)
        self.send_json(info)

    def container_exec(self, container_id: str) -> None:
        container_id = urllib.parse.unquote(container_id)
        spec = self.read_json()
        cmd = spec.get("Cmd") or []
        exec_id = f"bridge-{int(time.time()*1000)}-{len(EXEC_SESSIONS)}"
        with EXEC_LOCK:
            EXEC_SESSIONS[exec_id] = {
                "container": container_id,
                "cmd": [str(part) for part in cmd],
                "exit": None,
                "created": time.time(),
            }
            for key in [k for k, v in EXEC_SESSIONS.items() if time.time() - v["created"] > EXEC_SESSION_TTL]:
                EXEC_SESSIONS.pop(key, None)
        self.send_json({"Id": exec_id}, 201)

    def exec_action(self, exec_id: str, action: str, method: str) -> None:
        with EXEC_LOCK:
            session = EXEC_SESSIONS.get(exec_id)
        if session is None:
            return self.send_error_json(f"未知的 exec Id：{exec_id}", 404)

        if action == "json":
            return self.send_json({"ID": exec_id, "ExitCode": session["exit"]})

        if action == "resize":
            return self.send_response(200) or self.end_headers()

        if method != "POST":
            return self.send_error_json("exec start 需要 POST", 405)

        args = ["exec", session["container"], *session["cmd"]]
        code, out, err = docker_run(args, timeout=3600)
        with EXEC_LOCK:
            session["exit"] = code

        # dockerode 读 exec 流时会按 8 字节头做解复用，这里给它带头的帧：
        # [stream_type(1)][000][length(4)] + payload。stdout=1, stderr=2。
        def frames():
            if out:
                payload = out.encode("utf-8")
                yield b"\x01" + len(payload).to_bytes(4, "big") + payload
            if err:
                payload = err.encode("utf-8")
                yield b"\x02" + len(payload).to_bytes(4, "big") + payload

        self.stream_chunks(frames())


def main() -> int:
    parser = argparse.ArgumentParser(description="Docker API -> docker CLI bridge")
    parser.add_argument("--port", type=int, default=2375)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    code, out, err = docker_run(["--version"], timeout=30)
    if code != 0:
        print(f"docker 不可用：{err.strip() or out.strip()}")
        return 1
    print(f"docker: {out.strip()}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Bridge)
    server.daemon_threads = True
    print(f"LISTENING http://{args.host}:{args.port}  (DOCKER_HOST=tcp://{args.host}:{args.port})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
