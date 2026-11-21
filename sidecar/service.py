# -*- coding: utf-8 -*-
"""
关键位引擎的本地 HTTP 服务（供 Node 服务端调用）。

为什么是独立进程而不是嵌进 Node
--------------------------------
算法是上游的 numpy/pandas 实现，一字不改地跑才叫「移植」。所以 Python 这边只做计算，
Node 那边只做接口与界面；两边通过回环 HTTP 通信，进程各管各的。

约定
----
  * 只绑 127.0.0.1，端口由 Node 指定（--port 0 表示随便挑一个，启动后打印 READY <port>）
  * 口令从 --token 或环境变量 XFRINE_SIDECAR_TOKEN 来；每个请求必须带 x-sidecar-token
  * 停服条件：收到 SIGTERM/SIGINT，或者 stdin 关闭（父进程没了就跟着退，不留孤儿进程）

路由
----
  GET /health                          引擎自检（模型 / 校准 / 版本）
  POST /analyze_bars                   直接喂 K 线做分析（交易所实时行情那条路）
  GET /instruments?dir=                目录里的品种与周期
  GET /bars?dir=&symbol=&tf=&limit=    原始 K 线（图表用）
  GET /analyze?dir=&symbol=&tf=...     单品种分析
  GET /scan?dir=&tf=...                全市场扫描
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from http.server import ThreadingHTTPServer

_BASE = os.path.dirname(os.path.abspath(__file__))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

import pipeline  # noqa: E402
from http_api import Handler  # noqa: E402

# Windows 控制台默认 GBK，日志里混着中文和路径时会乱码；服务端日志是给人看的，统一 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover —— 老解释器没有 reconfigure
    pass


class SidecarServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, token: str = ""):
        super().__init__(addr, handler)
        self.token = token


_embedded_server: SidecarServer | None = None
_embedded_lock = threading.Lock()


def start_embedded(token: str, port: int = 0) -> int:
    """Start the loopback service inside an embedded Python runtime."""
    global _embedded_server
    token = str(token or "").strip()
    if len(token) < 16:
        raise ValueError("访问口令长度不足")

    with _embedded_lock:
        if _embedded_server is not None:
            if _embedded_server.token != token:
                raise RuntimeError("关键位引擎已使用另一访问口令启动")
            return int(_embedded_server.server_address[1])

        server = SidecarServer(("127.0.0.1", int(port)), Handler, token=token)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
        thread.start()
        _embedded_server = server
        state = pipeline.health()
        print("  引擎      v3fusion · python " + sys.version.split()[0], flush=True)
        print("  概率模型  " + ("已加载" if state["prob_ready"] else "缺失（界面不显示概率）"), flush=True)
        print("  校准表    " + ("已加载" if state["calibrated"] else "缺失（不显示分位档）"), flush=True)
        return int(server.server_address[1])


def _watch_parent(server: SidecarServer) -> None:
    """
    父进程（Node）退出后跟着退。

    桌面端把服务端当子进程拉起，Node 再把 sidecar 当孙进程拉起；Node 被强杀时
    管道关闭、stdin 收到 EOF，这里就退。不做这件事会在任务管理器里留下一堆
    python.exe 占着端口，下次启动就变成「端口被占用」的玄学问题。
    """
    try:
        while True:
            chunk = sys.stdin.buffer.readline()
            if not chunk:
                break
    except Exception:  # noqa: BLE001 —— 没有 stdin 时就不管这条防线
        return
    server.shutdown()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="关键位引擎 sidecar")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", default=os.environ.get("XFRINE_SIDECAR_TOKEN", ""))
    args = ap.parse_args(argv)
    token = str(args.token or "").strip()
    if len(token) < 16:
        ap.error("访问口令长度不足（至少 16 个字符）；请通过 --token 或 XFRINE_SIDECAR_TOKEN 提供")

    server = SidecarServer((args.host, args.port), Handler, token=token)
    port = server.server_address[1]

    def _bye(*_a) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _bye)
    signal.signal(signal.SIGINT, _bye)

    if not sys.stdin.isatty():
        threading.Thread(target=_watch_parent, args=(server,), daemon=True).start()

    # Node 靠这一行拿端口；之后 stdout 随便打，不影响解析
    print(f"READY {port}", flush=True)
    print(f"  引擎      v3fusion · python {sys.version.split()[0]}", flush=True)
    state = pipeline.health()
    print("  概率模型  " + ("已加载" if state["prob_ready"] else "缺失（界面不显示概率）"), flush=True)
    print("  校准表    " + ("已加载" if state["calibrated"] else "缺失（不显示分位档）"), flush=True)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
