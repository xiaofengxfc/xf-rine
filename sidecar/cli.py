# -*- coding: utf-8 -*-
"""
sidecar 调试用命令行。

服务端跑起来之后，一行命令就能确认「引擎、数据、概率模型」三件事是不是都通了：

    python sidecar/cli.py health
    python sidecar/cli.py instruments --dir sidecar/data/klines
    python sidecar/cli.py analyze --dir sidecar/data/klines --symbol BTC_USDT --tf D1
    python sidecar/cli.py scan    --dir sidecar/data/klines --tf H1

输出是 JSON，管道给别的工具也能直接吃。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_BASE = os.path.dirname(os.path.abspath(__file__))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

import pipeline  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="巡风关键位引擎 CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health", help="引擎自检")

    p_inst = sub.add_parser("instruments", help="列出目录里的品种")
    p_inst.add_argument("--dir", required=True)

    p_an = sub.add_parser("analyze", help="单品种分析")
    p_an.add_argument("--dir", required=True)
    p_an.add_argument("--symbol", required=True)
    p_an.add_argument("--tf", default="D1")
    p_an.add_argument("--window", type=int, default=40)
    p_an.add_argument("--n-zones", type=int, default=3)
    p_an.add_argument("--direction", default="long", choices=["long", "short", "both"])
    p_an.add_argument("--no-mtf", action="store_true")
    p_an.add_argument("--bars", type=int, default=0, help="只打印前 N 根 K 线（0=不打印）")

    p_sc = sub.add_parser("scan", help="全市场扫描")
    p_sc.add_argument("--dir", required=True)
    p_sc.add_argument("--tf", default="D1")
    p_sc.add_argument("--window", type=int, default=40)
    p_sc.add_argument("--n-zones", type=int, default=3)
    p_sc.add_argument("--direction", default="long", choices=["long", "short", "both"])

    args = ap.parse_args(argv)

    try:
        if args.cmd == "health":
            out = pipeline.health()
        elif args.cmd == "instruments":
            out = pipeline.instruments(args.dir)
        elif args.cmd == "analyze":
            out = pipeline.analyze(args.dir, args.symbol, args.tf,
                                   window=args.window, n_zones=args.n_zones,
                                   direction=args.direction, mtf=not args.no_mtf)
            if not args.bars:
                out.pop("kline", None)
            else:
                out["kline"] = {k: v[: args.bars] for k, v in out["kline"].items()}
        elif args.cmd == "scan":
            out = pipeline.scan(args.dir, tf=args.tf, window=args.window,
                                n_zones=args.n_zones, direction=args.direction)
        else:  # pragma: no cover
            ap.error("未知命令")
            return 2
    except Exception as e:  # noqa: BLE001 —— CLI 的职责就是把错误原样说清
        print(json.dumps({"error": str(e), "type": type(e).__name__},
                         ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
