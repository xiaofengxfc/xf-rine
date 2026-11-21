"""Check the sidecar HTTP contract without installing the numerical engine."""

from __future__ import annotations

import json
import sys
import threading
import types
import urllib.error
import urllib.request
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR_DIR))

calls: list[tuple[str, tuple, dict]] = []


def result(name: str):
    def capture(*args, **kwargs):
        calls.append((name, args, kwargs))
        return {"operation": name}

    return capture


pipeline = types.ModuleType("pipeline")
pipeline.health = lambda: {"ok": True, "engine": "stub"}
pipeline.instruments = result("instruments")
pipeline.bars = result("bars")
pipeline.analyze = result("analyze")
pipeline.scan = result("scan")
pipeline.analyze_bars = result("analyze_bars")
sys.modules["pipeline"] = pipeline

from http_api import Handler
from service import SidecarServer


TOKEN = "sidecar-contract-test-token"
server = SidecarServer(("127.0.0.1", 0), Handler, token=TOKEN)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base_url = "http://127.0.0.1:" + str(server.server_address[1])
passed = 0


def request(path: str, *, token: str = TOKEN, method: str = "GET", body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {} if not token else {"x-sidecar-token": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read().decode("utf-8"))


def check(name: str, condition: bool):
    global passed
    if not condition:
        raise AssertionError(name)
    passed += 1
    print("  ✓ " + name)


try:
    status, body = request("/health", token="")
    check("GET requests require the service token", status == 401 and body["error"] == "SIDECAR_TOKEN_REQUIRED")

    status, body = request("/health")
    check("health response keeps its JSON contract", status == 200 and body == {"ok": True, "engine": "stub"})

    status, body = request("/instruments")
    check("instrument list requires a data directory", status == 400 and body["error"] == "缺少 dir")

    status, body = request("/instruments?dir=sample")
    check("instrument list delegates to the pipeline", status == 200 and body == {"operation": "instruments"})

    status, body = request("/bars?dir=sample")
    check("bar request requires both directory and symbol", status == 400 and body["error"] == "缺少 dir 或 symbol")

    status, body = request("/bars?dir=sample&symbol=BTC_USDT&limit=bad")
    check(
        "bar request retains its timeframe and invalid-limit defaults",
        status == 200
        and calls[-1] == ("bars", ("sample", "BTC_USDT", "D1", 500), {}),
    )

    status, body = request("/analyze?dir=sample&symbol=BTC_USDT&direction=unknown&mtf=off")
    check(
        "analyze request retains direction, MTF, and window defaults",
        status == 200
        and calls[-1] == (
            "analyze",
            ("sample", "BTC_USDT"),
            {"tf": "D1", "window": 40, "n_zones": 3, "direction": "long", "mtf": False, "n_bars": 300},
        ),
    )

    status, body = request("/scan?dir=sample&direction=short&tf=H1")
    check(
        "scan request forwards timeframe and direction",
        status == 200
        and calls[-1] == (
            "scan",
            ("sample",),
            {"tf": "H1", "window": 40, "n_zones": 3, "direction": "short"},
        ),
    )

    status, body = request(
        "/analyze_bars",
        method="POST",
        body={"symbol": "BTC_USDT", "frames": [{"tf": "D1", "bars": []}]},
    )
    check(
        "live-candle analysis keeps its request shape and defaults",
        status == 200
        and calls[-1] == (
            "analyze_bars",
            (),
            {
                "symbol": "BTC_USDT", "tf": "D1", "frames": [{"tf": "D1", "bars": []}],
                "n_zones": 3, "direction": "long", "mtf": True, "tick": 0.0, "n_bars": 0,
            },
        ),
    )

    status, body = request("/missing")
    check("unknown routes remain JSON 404 responses", status == 404 and body["path"] == "/missing")

    status, body = request("/analyze_bars", token="", method="POST", body={})
    check("POST requests require the same service token", status == 401 and body["error"] == "SIDECAR_TOKEN_REQUIRED")
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)

print(f"Sidecar HTTP checks passed: {passed}")
