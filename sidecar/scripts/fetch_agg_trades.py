
# -*- coding: utf-8 -*-
"""从 Binance Vision 下载逐笔 aggTrades，聚合成 4h/1d 的大单与主动买卖特征。

只保留聚合结果，ZIP 和 CSV 处理完就删。默认 4h。
用法：
    python sidecar/scripts/fetch_agg_trades.py --symbols BTC_USDT,ETH_USDT --start 2025-01-01 --end 2025-03-31
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://data.binance.vision/data/futures/um/daily/aggTrades"

DEFAULT_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT"]
INTERVAL_SECONDS = {"4h": 4 * 3600, "1h": 3600, "1d": 86400}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="下载 Binance aggTrades 并聚合成大单/主动买卖特征")
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--start", default="2025-01-01")
    p.add_argument("--end", default="2025-03-31")
    p.add_argument("--interval", default="4h", choices=sorted(INTERVAL_SECONDS))
    p.add_argument("--out", default=str(ROOT / ".scratch/pattern-context/cache/agg"))
    p.add_argument("--large-usd", type=float, default=50_000.0)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def day_range(start: str, end: str):
    d = date.fromisoformat(start)
    last = date.fromisoformat(end)
    while d <= last:
        yield d
        d += timedelta(days=1)


def download(url: str, path: Path) -> bool:
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "xf-rine/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            path.write_bytes(data)
            return True
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                print("  miss", url, e, flush=True)
                return False
            time.sleep(1.0)
    return False


def aggregate_day(sym: str, d: date, interval_sec: int, large_usd: float) -> dict[int, dict]:
    bsym = sym.replace("_USDT", "USDT")
    name = f"{bsym}-aggTrades-{d.isoformat()}.zip"
    url = f"{BASE}/{bsym}/{name}"
    tmp = Path(os.environ.get("TEMP", ".")) / f"xf-agg-{bsym}-{d.isoformat()}.zip"
    if not download(url, tmp):
        return {}
    out: dict[int, dict] = {}
    long_ms = interval_sec * 1000
    late_ms = long_ms - 3600_000
    try:
        with zipfile.ZipFile(tmp) as z:
            inner = z.namelist()[0]
            with z.open(inner) as fh:
                text = io.TextIOWrapper(fh, encoding="utf-8", newline="")
                reader = csv.reader(text)
                header = next(reader)
                idx = {k: i for i, k in enumerate(header)}
                ip, iq, it, im = idx["price"], idx["quantity"], idx["transact_time"], idx["is_buyer_maker"]
                for row in reader:
                    try:
                        price = float(row[ip]); qty = float(row[iq]); ms = int(row[it])
                    except (ValueError, IndexError):
                        continue
                    bucket = (ms // long_ms) * interval_sec
                    rec = out.get(bucket)
                    if rec is None:
                        rec = {"buy": 0.0, "sell": 0.0, "largeBuy": 0.0, "largeSell": 0.0,
                               "lateBuy": 0.0, "lateSell": 0.0, "trades": 0, "largeTrades": 0}
                        out[bucket] = rec
                    notional = price * qty
                    is_buy = row[im].strip().lower() == "false"
                    if is_buy:
                        rec["buy"] += qty
                        if ms % long_ms >= late_ms:
                            rec["lateBuy"] += qty
                    else:
                        rec["sell"] += qty
                        if ms % long_ms >= late_ms:
                            rec["lateSell"] += qty
                    rec["trades"] += 1
                    if notional >= large_usd:
                        rec["largeTrades"] += 1
                        if is_buy:
                            rec["largeBuy"] += qty
                        else:
                            rec["largeSell"] += qty
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return out


def run_symbol(sym: str, args: argparse.Namespace, interval_sec: int, out_dir: Path) -> None:
    out_file = out_dir / f"{sym}_{args.interval}.json"
    existing: dict[int, dict] = {}
    if out_file.exists() and not args.force:
        try:
            for rec in json.loads(out_file.read_text(encoding="utf-8")):
                existing[int(rec["t"])] = rec
        except Exception:  # noqa: BLE001
            existing = {}
    t0 = time.time()
    added = 0
    for d in day_range(args.start, args.end):
        day = aggregate_day(sym, d, interval_sec, args.large_usd)
        for bucket, rec in day.items():
            if bucket in existing:
                continue
            rec["t"] = bucket
            existing[bucket] = rec
            added += 1
        print(f"  {sym} {d.isoformat()}: {len(day)} buckets, total {len(existing)}, {time.time()-t0:.0f}s", flush=True)
    rows = [existing[k] for k in sorted(existing)]
    out_file.write_text(json.dumps(rows), encoding="utf-8")
    print(f"done {sym}: {len(rows)} buckets, +{added} -> {out_file}", flush=True)


def main() -> None:
    args = parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    interval_sec = INTERVAL_SECONDS[args.interval]
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(run_symbol, sym, args, interval_sec, out_dir) for sym in symbols]
        for f in futures:
            f.result()
    print("done")


if __name__ == "__main__":
    main()
