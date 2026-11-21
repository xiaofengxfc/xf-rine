"""HTTP protocol handling for the local support/resistance service."""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

_BASE = os.path.dirname(os.path.abspath(__file__))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

import pipeline  # noqa: E402


DIRECTION_CHOICES = {"long", "short", "both"}


def _q(qs: Dict[str, list], key: str, default: str = "") -> str:
    values = qs.get(key)
    return (values[0] if values else default) or default


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

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        want = self.server.token  # type: ignore[attr-defined]
        if len(want) < 16:
            return False
        given = self.headers.get("x-sidecar-token", "")
        if len(given) != len(want):
            return False
        diff = 0
        for a, b in zip(given, want):
            diff |= ord(a) ^ ord(b)
        return diff == 0

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's interface
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
        except FileNotFoundError as error:
            self._send_json(404, {"error": str(error), "type": "FileNotFoundError"})
        except ValueError as error:
            self._send_json(400, {"error": str(error), "type": "ValueError"})
        except Exception as error:  # noqa: BLE001 — return a response instead of hanging the client
            import traceback

            traceback.print_exc()
            self._send_json(500, {"error": str(error), "type": type(error).__name__})

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's interface
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
        except ValueError as error:
            self._send_json(400, {"error": str(error), "type": "ValueError"})
        except Exception as error:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self._send_json(500, {"error": str(error), "type": type(error).__name__})

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return
