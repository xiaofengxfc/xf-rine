
# -*- coding: utf-8 -*-
"""导出 sidecar V3Fusion 的关键位时间线，供 TypeScript 侧按根查询。

用法：
    python sidecar/scripts/export_levels_timeline.py
    python sidecar/scripts/export_levels_timeline.py --symbols BTC_USDT,ETH_USDT --intervals 4h
    python sidecar/scripts/export_levels_timeline.py --force --every 50

只取原始 levels，不套 SREngine.detect 的展示后处理 —— 它会把距现价 <0.5 ATR 的位丢掉，
而「价格就在支撑上」正是条件实验要的状态。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

from src.sr_engine import SREngine  # noqa: E402

DEFAULT_SYMBOLS = [
    "BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT", "XRP_USDT", "BNB_USDT", "ADA_USDT", "LINK_USDT",
    "AVAX_USDT", "DOT_USDT", "LTC_USDT", "TRX_USDT", "ATOM_USDT", "UNI_USDT", "FIL_USDT", "ETC_USDT",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="导出支撑阻力关键位时间线")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS), help="逗号分隔，默认 16 个 USDT 永续")
    p.add_argument("--intervals", default="4h,1d", help="逗号分隔，默认 4h,1d")
    p.add_argument("--bars-dir", default=str(ROOT / ".scratch/pattern-context/cache/bars"))
    p.add_argument("--out", default=str(ROOT / ".scratch/pattern-context/cache/levels"))
    p.add_argument("--every", type=int, default=50, help="每多少根重算一次；默认 50")
    p.add_argument("--start", type=int, default=300, help="从第几根开始；默认 300")
    p.add_argument("--topn", type=int, default=12, help="每片保留多少个位；默认 12")
    p.add_argument("--force", action="store_true", help="覆盖已有文件")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    intervals = [s.strip() for s in args.intervals.split(",") if s.strip()]
    bars_dir = Path(args.bars_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for iv in intervals:
        for sym in symbols:
            src = bars_dir / f"{sym}_{iv}.json"
            dst = out_dir / f"{sym}_{iv}.json"
            if not src.exists():
                print(f"skip {sym} {iv}: 没有 K 线 {src}")
                continue
            if dst.exists() and not args.force:
                print(f"exists {sym} {iv}")
                continue
            bars = json.loads(src.read_text(encoding="utf-8"))
            df = pd.DataFrame(bars)[["open", "high", "low", "close", "volume"]].astype(float)
            n = len(df)
            if n < args.start + 100:
                print(f"skip {sym} {iv}: 太短 {n}")
                continue
            eng = SREngine(n_zones=6)
            slices = []
            t0 = time.time()
            for i in range(args.start, n, args.every):
                try:
                    ctx = eng.build_ctx(df.iloc[: i + 1], sym)
                    levels = eng.det.detect(ctx)
                except Exception as e:  # noqa: BLE001
                    print(f"err {sym} {iv} {i}: {e!r}")
                    levels = []
                kept = [z for z in levels if getattr(z, "kind", None) in ("support", "resistance")]
                kept.sort(key=lambda z: -float(getattr(z, "score", 0.0)))
                zones = [
                    {
                        "center": float(z.center),
                        "low": float(z.low),
                        "high": float(z.high),
                        "type": z.kind,
                        "edge": float(getattr(z, "score", 0.0)),
                    }
                    for z in kept[: args.topn]
                ]
                slices.append({"from": i, "to": min(i + args.every - 1, n - 1), "zones": zones})
                if len(slices) % 40 == 0:
                    total = (n - args.start + args.every - 1) // args.every
                    print(f"{sym} {iv} {len(slices)}/{total} {time.time() - t0:.1f}s", flush=True)
            dst.write_text(
                json.dumps(
                    {"symbol": sym, "iv": iv, "every": args.every, "start": args.start, "bars": n, "slices": slices},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            print(f"done {sym} {iv} {len(slices)} slices {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
