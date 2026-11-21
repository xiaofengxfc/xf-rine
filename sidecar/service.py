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
import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

_BASE = os.path.dirname(os.path.abspath(__file__))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

import pipeline  # noqa: E402

# Windows 控制台默认 GBK，日志里混着中文和路径时会乱码；服务端日志是给人看的，统一 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover —— 老解释器没有 reconfigure
    pass


DIRECTION_CHOICES = {"long", "short", "both"}


def _q(qs: Dict[str, list], key: str, default: str = "") -> str:
    v = qs.get(key)
    return (v[0] if v else default) or default


def _qint(qs: Dict[str, list], key: str, default: int) -> int:
    try:
        return int(_q(qs, key, str(default)))
    except (TypeError, ValueError):
        return default


def _qbool(qs: Dict[str, list], key: str, default: bool) -> bool:
    raw = _q(qs, key, "")
    if not raw:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Handler(BaseHTTPRequestHandler):
    server_version = "XfrineSidecar/1.0"
    protocol_version = "HTTP/1.1"

    # Node 那边等的是「谁在回答」，不是「有人回答」；把口令放在每个响应头里也方便排查
    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        want = self.server.token  # type: ignore[attr-defined]
        if not want:
            return True
        given = self.headers.get("x-sidecar-token", "")
        # 定长比较，别让口令从响应时间里一位一位被试出来
        if len(given) != len(want):
            return False
        diff = 0
        for a, b in zip(given, want):
            diff |= ord(a) ^ ord(b)
        return diff == 0

    def do_GET(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的接口
        if not self._auth_ok():
            self._send_json(401, {"error": "SIDECAR_TOKEN_REQUIRED"})
            return

        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        route = parsed.path.rstrip("/") or "/"

        try:
            if route == "/health":
                self._send_json(200, pipeline.health())
                return

            if route == "/instruments":
                data_dir = _q(qs, "dir")
                if not data_dir:
                    self._send_json(400, {"error": "缺少 dir"})
                    return
                self._send_json(200, pipeline.instruments(data_dir))
                return

            if route == "/bars":
                data_dir = _q(qs, "dir")
                symbol = _q(qs, "symbol")
                if not data_dir or not symbol:
                    self._send_json(400, {"error": "缺少 dir 或 symbol"})
                    return
                self._send_json(200, pipeline.bars(
                    data_dir, symbol, _q(qs, "tf", "D1"), _qint(qs, "limit", 500)))
                return

            if route == "/analyze":
                data_dir = _q(qs, "dir")
                symbol = _q(qs, "symbol")
                if not data_dir or not symbol:
                    self._send_json(400, {"error": "缺少 dir 或 symbol"})
                    return
                direction = _q(qs, "direction", "long")
                out = pipeline.analyze(
                    data_dir, symbol,
                    tf=_q(qs, "tf", "D1"),
                    window=_qint(qs, "window", 40),
                    n_zones=_qint(qs, "n_zones", 3),
                    direction=direction if direction in DIRECTION_CHOICES else "long",
                    mtf=_qbool(qs, "mtf", True),
                    n_bars=_qint(qs, "n_bars", 300),
                )
                self._send_json(200, out)
                return

            if route == "/scan":
                data_dir = _q(qs, "dir")
                if not data_dir:
                    self._send_json(400, {"error": "缺少 dir"})
                    return
                direction = _q(qs, "direction", "long")
                out = pipeline.scan(
                    data_dir,
                    tf=_q(qs, "tf", "D1"),
                    window=_qint(qs, "window", 40),
                    n_zones=_qint(qs, "n_zones", 3),
                    direction=direction if direction in DIRECTION_CHOICES else "long",
                )
                self._send_json(200, out)
                return

            self._send_json(404, {"error": "没有这个接口", "path": route})
        except FileNotFoundError as e:
            self._send_json(404, {"error": str(e), "type": "FileNotFoundError"})
        except ValueError as e:
            self._send_json(400, {"error": str(e), "type": "ValueError"})
        except Exception as e:  # noqa: BLE001 —— 任何异常都要变成 5xx，不能把连接吊死
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": str(e), "type": type(e).__name__})

    def do_POST(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的接口
        if not self._auth_ok():
            self._send_json(401, {"error": "SIDECAR_TOKEN_REQUIRED"})
            return
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")

            if route == "/analyze_bars":
                # 交易所实时行情那条路：K 线由 Node 那边（或前端）给，这里只算
                frames = body.get("frames") or []
                out = pipeline.analyze_bars(
                    symbol=str(body.get("symbol") or ""),
                    tf=str(body.get("tf") or "D1"),
                    frames=frames,
                    n_zones=int(body.get("n_zones") or 3),
                    direction=str(body.get("direction") or "long"),
                    mtf=bool(body.get("mtf", True)),
                    tick=float(body.get("tick") or 0),
                    n_bars=int(body.get("n_bars") or 0),
                )
                self._send_json(200, out)
                return

            self._send_json(404, {"error": "没有这个接口", "path": route})
        except ValueError as e:
            self._send_json(400, {"error": str(e), "type": "ValueError"})
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": str(e), "type": type(e).__name__})

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # 默认会把每个请求打到 stderr；Node 已经有一份日志，这边只留错误
        return


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

    server = SidecarServer((args.host, args.port), Handler, token=args.token)
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
