# -*- coding: utf-8 -*-
"""
引擎运行层：把上游 src/sr_engine.py 包成「一次分析 / 一次全市场扫描」两个动作。

为什么要有这一层
----------------
上游 app.py 把 Flask 路由、JSON 组装、算法调用混在一起。搬到巡风之后，接口层在 Node
（Express）那边，Python 这边只该负责「读数据 → 算 → 返回结构」。所以这里把 app.py 里
_analyze_df / api_analyze_all 的那段逻辑原样搬过来，去掉 Flask 依赖。

口径与上游一致：
  - 每侧最多 n_zones 个位（上游 SREngine 内部再把总数对半分），距离带 [0.5, 5] ATR
  - 多周期共振：邻居周期各自检测，按中心价距离 <= 0.8 ATR 认定同一个位
  - 概率：data/prob_models.json 的 touch × hold；校准：data/score_calibration.json

JSON 安全：上游返回的是 numpy 标量（np.float64 之类），json.dumps 不认。
所有出口都过一遍 _jsonable，别让服务端在序列化时炸掉。
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

_BASE = os.path.dirname(os.path.abspath(__file__))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

import numpy as np  # noqa: E402

from src.local_data_loader import (  # noqa: E402
    TIMEFRAME_LABELS, _filepath, list_instruments, load_kline,
    pick_mtf_timeframes, std_tf,
)
from src.sr_engine import (  # noqa: E402
    DIRECTION_LABELS, SREngine, attach_mtf, build_summary, get_calibration,
    get_prob_models,
)

# 与上游一致：数据不足 60 根不分析
MIN_BARS = 60

# 读盘缓存：一次全市场扫描会把目录里每个文件读一遍，界面紧接着再点单品种分析时
# 不该再读一次。键里带文件 mtime 和大小，文件被替换（重新导出数据）后自动失效。
_DF_CACHE: Dict[tuple, Any] = {}
_DF_CACHE_ORDER: List[tuple] = []
_DF_CACHE_MAX = 48


def _load_cached(data_dir: str, symbol: str, tf: str):
    """带缓存的 load_kline。上游每次调用都重新读 parquet，批量扫描时会重复读同一批文件。"""
    try:
        path = _filepath(data_dir, symbol, tf)
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        key = (os.path.abspath(data_dir), symbol, std_tf(tf), 0, 0)
    hit = _DF_CACHE.get(key)
    if hit is not None:
        return hit
    df = load_kline(data_dir, symbol, tf)
    _DF_CACHE[key] = df
    _DF_CACHE_ORDER.append(key)
    while len(_DF_CACHE_ORDER) > _DF_CACHE_MAX:
        _DF_CACHE.pop(_DF_CACHE_ORDER.pop(0), None)
    return df


# ============================================================
# 工具
# ============================================================
def _jsonable(obj: Any) -> Any:
    """把 numpy 标量 / 数组换成原生类型，递归处理 dict/list"""
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        return v if np.isfinite(v) else None
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return [_jsonable(v) for v in obj.tolist()]
    if isinstance(obj, float):
        return obj if np.isfinite(obj) else None
    return obj


def _safe_token(value: str, what: str) -> str:
    """
    品种名 / 周期只允许普通的文件名片段。

    服务端传进来的东西最终会拼进路径（{品种}_{周期}.parquet），
    带 .. 或分隔符就能跳出数据目录。Python 这边不管权限、只管形状：
    形状不对直接拒，别让它碰到 os.stat。
    """
    v = (value or "").strip()
    if not v:
        raise ValueError(f"缺少{what}")
    if len(v) > 64 or any(ch in v for ch in ("/", "\\", ":", "*", "?", '"', "<", ">", "|")):
        raise ValueError(f"{what}不合法: {v}")
    if v in (".", "..") or v.startswith(".."):
        raise ValueError(f"{what}不合法: {v}")
    return v


def _engine_state() -> Dict[str, Any]:
    calib = get_calibration()
    probs = get_prob_models()
    return {
        "calibrated": bool(calib.ok),
        "calib_meta": calib.meta,
        "prob_ready": bool(probs.ok),
        "prob_meta": probs.meta,
    }


# ============================================================
# 单品种分析
# ============================================================
def analyze(data_dir: str, symbol: str, tf: str = "D1",
            window: int = 40, n_zones: int = 3, direction: str = "long",
            mtf: bool = True, n_bars: int = 300) -> Dict[str, Any]:
    """对单个品种做一个周期的完整分析。返回结构与上游 /api/analyze 对齐。"""
    symbol = _safe_token(symbol, "品种")
    tf = _safe_token((tf or "D1").strip().upper(), "周期")
    if direction not in DIRECTION_LABELS:
        direction = "long"
    window = max(10, min(int(window), 500))
    n_zones = max(1, min(int(n_zones), 8))

    df = _load_cached(data_dir, symbol, tf)
    if len(df) < MIN_BARS:
        raise ValueError(f"数据不足：仅 {len(df)} 条，需要 ≥ {MIN_BARS} 条")

    current_price = float(df["close"].iloc[-1])
    latest_pct = float(df["pct_chg"].iloc[-1]) if "pct_chg" in df.columns else 0.0

    eng = SREngine(n_zones=n_zones * 2)
    zones, info = eng.detect(df, symbol)
    if info.get("error"):
        raise ValueError(info["error"])

    mtf_zones: List[Dict[str, Any]] = []
    if mtf:
        available = list_instruments(data_dir).get(symbol, [])
        for ntf, _weight, _nwin in pick_mtf_timeframes(tf, available):
            if ntf == tf:
                continue
            try:
                ndf = _load_cached(data_dir, symbol, ntf)
                if len(ndf) < MIN_BARS:
                    continue
                nz, _ninfo = SREngine(n_zones=n_zones * 2).detect(ndf, symbol)
                mtf_zones.append({
                    "tf": ntf,
                    "tf_label": TIMEFRAME_LABELS.get(ntf, ntf),
                    "zones": nz,
                })
            except Exception:
                # 该周期读不到（文件缺失 / 数据坏）就跳过，不让它拖垮主周期
                continue
        attach_mtf(zones, mtf_zones, info["atr"])

    summary = build_summary(zones, df, direction, info)
    # 概率模型 / 校准的状态要跟着结果走：界面据此决定显不显示概率列
    info.update(_engine_state())

    kline = _bars_json(df, n_bars)
    return _jsonable({
        "symbol": symbol,
        "symbol_label": symbol,
        "tf": tf,
        "tf_label": TIMEFRAME_LABELS.get(tf, tf),
        "current_price": round(current_price, 6),
        "change_pct": round(latest_pct, 4),
        "window": window,
        "n_zones": len(zones),
        "data_bars": len(df),
        "zones": zones,
        "mtf_zones": mtf_zones,
        "summary": summary,
        "engine": info,
        "direction": direction,
        "direction_label": DIRECTION_LABELS.get(direction, direction),
        "kline": kline,
        "kline_total": len(df),
    })


def _bars_json(df, n_bars: int) -> Dict[str, List[float]]:
    """图表用的 K 线：时间统一成 unix 秒，便于前端 lightweight-charts 直接用"""
    recent = df.tail(max(int(n_bars), 1))
    # epoch 是读文件时按原始时间戳留下的 unix 秒，不经过 datetime 单位换算
    epoch = recent["epoch"].astype("int64").tolist()
    return {
        "time": [int(t) for t in epoch],
        "open": [round(float(x), 8) for x in recent["open"].tolist()],
        "high": [round(float(x), 8) for x in recent["high"].tolist()],
        "low": [round(float(x), 8) for x in recent["low"].tolist()],
        "close": [round(float(x), 8) for x in recent["close"].tolist()],
        "volume": [round(float(x), 4) for x in recent["volume"].tolist()],
    }


# ============================================================
# 直接喂 K 线的分析（交易所实时行情那条路）
# ============================================================
def _frame_from_bars(bars: List[Dict[str, Any]]) -> "Any":
    """
    把前端/Node 传来的 K 线数组变成引擎要的 DataFrame。

    清洗口径和 load_kline 的通用分支一致：数值化、丢坏行、按时间排序去重、
    补 amount / turn / pct_chg。交易所来的数据本来就是干净连续的，
    这里只是把「保证列名和顺序」这件事补齐。
    """
    import pandas as pd

    if not bars:
        raise ValueError("K 线为空")
    df = pd.DataFrame(bars)
    need = ["time", "open", "high", "low", "close"]
    for c in need:
        if c not in df.columns:
            raise ValueError(f"K 线缺少列: {c}")
    if "volume" not in df.columns:
        df["volume"] = 0.0
    df["date"] = pd.to_datetime(pd.to_numeric(df["time"], errors="coerce"),
                                unit="s", utc=True).dt.tz_convert(
        "Asia/Shanghai").dt.tz_localize(None)
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df = df.dropna(subset=["date", "open", "high", "low", "close"])
    ok = (df["high"] >= df["low"]) & (df["low"] > 0)
    df = df[ok].sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    if len(df) == 0:
        raise ValueError("K 线清洗后为空")
    df["amount"] = df["close"] * df["volume"]
    df["turn"] = 0.0
    df["pct_chg"] = df["close"].pct_change().fillna(0.0) * 100
    df["epoch"] = pd.to_numeric(df["time"], errors="coerce").round().astype("int64")
    return df[
        ["date", "epoch", "open", "high", "low", "close", "volume",
         "amount", "turn", "pct_chg"]
    ]


def analyze_bars(symbol: str, tf: str, frames: List[Dict[str, Any]],
                 n_zones: int = 3, direction: str = "long", mtf: bool = True,
                 tick: float = 0.0, n_bars: int = 0) -> Dict[str, Any]:
    """
    分析一组直接给进来的 K 线（交易所实时行情用，不落盘）。

    frames 第一项是主周期，其余是邻居周期（按 D1/H4/H1 这类标准名报上来）。
    多周期共振的判定与本地数据那条路完全一样 —— 都是 attach_mtf。
    """
    symbol = _safe_token(symbol, "品种")
    tf = _safe_token((tf or "D1").strip().upper(), "周期")
    if direction not in DIRECTION_LABELS:
        direction = "long"
    n_zones = max(1, min(int(n_zones), 8))
    if not frames:
        raise ValueError("缺少 K 线")

    main = frames[0]
    df = _frame_from_bars(main.get("bars") or [])
    if tick and tick > 0:
        # 合约的最小变动价，比按收盘价估准
        df.attrs["tick_base"] = float(tick)
    if len(df) < MIN_BARS:
        raise ValueError(f"数据不足：仅 {len(df)} 条，需要 ≥ {MIN_BARS} 条")

    price = float(df["close"].iloc[-1])
    pct = float(df["pct_chg"].iloc[-1]) if len(df) else 0.0

    zones, info = SREngine(n_zones=n_zones * 2).detect(df, symbol)
    if info.get("error"):
        raise ValueError(info["error"])

    mtf_zones: List[Dict[str, Any]] = []
    if mtf:
        for fr in frames[1:]:
            try:
                ndf = _frame_from_bars(fr.get("bars") or [])
                if len(ndf) < MIN_BARS:
                    continue
                nz, _ = SREngine(n_zones=n_zones * 2).detect(ndf, symbol)
                code = str(fr.get("tf") or "").upper()
                mtf_zones.append({
                    "tf": code,
                    "tf_label": TIMEFRAME_LABELS.get(code, code),
                    "zones": nz,
                })
            except Exception:
                continue
        attach_mtf(zones, mtf_zones, info["atr"])

    summary = build_summary(zones, df, direction, info)
    info.update(_engine_state())

    out: Dict[str, Any] = {
        "symbol": symbol,
        "symbol_label": symbol,
        "tf": tf,
        "tf_label": TIMEFRAME_LABELS.get(tf, tf),
        "current_price": round(price, 8),
        "change_pct": round(pct, 4),
        "window": 0,
        "n_zones": len(zones),
        "data_bars": len(df),
        "zones": zones,
        "mtf_zones": mtf_zones,
        "summary": summary,
        "engine": info,
        "direction": direction,
        "direction_label": DIRECTION_LABELS.get(direction, direction),
        "kline_total": len(df),
    }
    if n_bars:
        out["kline"] = _bars_json(df, n_bars)
    return _jsonable(out)


# ============================================================
# 全市场扫描
# ============================================================
def scan(data_dir: str, tf: str = "D1", window: int = 40, n_zones: int = 3,
         direction: str = "long", symbols: Optional[List[str]] = None) -> Dict[str, Any]:
    """一键分析目录里所有品种，按有效概率（触及 × 守住）降序返回。"""
    tf = (tf or "D1").strip().upper()
    if direction not in DIRECTION_LABELS:
        direction = "long"
    window = max(10, min(int(window), 500))
    n_zones = max(1, min(int(n_zones), 8))

    instruments = list_instruments(data_dir)
    target = symbols if symbols else list(instruments.keys())
    rows: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    for symbol in target:
        if tf not in instruments.get(symbol, []):
            continue
        try:
            df = _load_cached(data_dir, symbol, tf)
            if len(df) < MIN_BARS:
                errors.append({"symbol": symbol, "reason": f"数据不足({len(df)}条)"})
                continue

            current_price = float(df["close"].iloc[-1])
            latest_pct = float(df["pct_chg"].iloc[-1]) if "pct_chg" in df.columns else 0.0
            zones, info = SREngine(n_zones=n_zones * 2).detect(df, symbol)
            if info.get("error"):
                errors.append({"symbol": symbol, "reason": info["error"]})
                continue
            summary = build_summary(zones, df, direction, info)

            sups = [z for z in zones if z["zone_type"] == "support"]
            ress = [z for z in zones if z["zone_type"] == "resistance"]
            n_sup = min(sups, key=lambda z: abs(z["distance_atr"])) if sups else None
            n_res = min(ress, key=lambda z: abs(z["distance_atr"])) if ress else None
            nearest = summary.get("nearest")

            rows.append({
                "symbol": symbol,
                "tf": tf,
                "current_price": round(current_price, 6),
                "change_pct": round(latest_pct, 4),
                "n_zones": len(zones),
                "nearest_support": n_sup["center"] if n_sup else None,
                "nearest_support_dist_pct": n_sup["distance_pct"] if n_sup else None,
                "nearest_resistance": n_res["center"] if n_res else None,
                "nearest_resistance_dist_pct": n_res["distance_pct"] if n_res else None,
                # 双概率（触及 + 守住）
                "p_touch": nearest.get("p_touch") if nearest else None,
                "p_hold": nearest.get("p_hold") if nearest else None,
                "p_effective": nearest.get("p_effective") if nearest else None,
                "edge_score": nearest["edge_score"] if nearest else None,
                "n_events": nearest["n_events"] if nearest else None,
                "width_atr": nearest["width_atr"] if nearest else None,
                "nearest_distance_pct": nearest["distance_pct"] if nearest else None,
                "nearest_distance_atr": nearest["distance_atr"] if nearest else None,
                "bucket": nearest.get("bucket") if nearest else None,
                "p_stall": nearest.get("p_stall") if nearest else None,
                "trend_label": summary["trend_label"],
                "direction": direction,
                "data_bars": len(df),
                "atr_pct": info.get("atr_pct"),
                # 复权状态逐行暴露：批量表里大部分标的可能缺因子而降级为不复权，
                # 只在详情页告警会让这张表骗人
                "adjusted": info.get("adjust_source") == "factor_cache",
                "adjust_source": info.get("adjust_source"),
            })
        except Exception as e:  # noqa: BLE001 —— 单个标的失败不该中断整轮扫描
            errors.append({"symbol": symbol, "reason": str(e)})
            continue

    # 排序：有效概率降序；没有概率的按 edge_score，再没有的排最后
    def _sort_key(r: Dict[str, Any]):
        if r.get("p_effective") is not None:
            return (0, -float(r["p_effective"]))
        if r.get("edge_score") is not None:
            return (1, -float(r["edge_score"]))
        return (2, 0.0)

    rows.sort(key=_sort_key)

    n_adj = sum(1 for r in rows if r.get("adjusted"))
    state = _engine_state()
    summary = {
        "total": len(rows) + len(errors),
        "analyzed": len(rows),
        "failed": len(errors),
        "n_adjusted": n_adj,
        "n_unadjusted": len(rows) - n_adj,
        "tf": tf,
        "tf_label": TIMEFRAME_LABELS.get(tf, tf),
        "window": window,
        "n_zones": n_zones,
        "direction": direction,
        "direction_label": DIRECTION_LABELS.get(direction, direction),
        "data_dir": data_dir,
        **state,
    }
    return _jsonable({"summary": summary, "rows": rows, "errors": errors})


# ============================================================
# 元信息
# ============================================================
def instruments(data_dir: str) -> Dict[str, Any]:
    if not os.path.isdir(data_dir):
        raise ValueError(f"文件夹不存在: {data_dir}")
    inst = list_instruments(data_dir)
    # 文件数：目录里能认出来的 K 线文件有几个（认不出的不算，界面上会说「几个文件」）
    files = 0
    try:
        for fn in os.listdir(data_dir):
            if fn.lower().endswith((".parquet", ".csv")) and _parse_ok(fn):
                files += 1
    except OSError:
        files = 0
    return {
        "data_dir": data_dir,
        "count": len(inst),
        "instruments": [{"symbol": s, "timeframes": tfs} for s, tfs in inst.items()],
        "tf_labels": TIMEFRAME_LABELS,
        "files": files,
    }


def _parse_ok(filename: str) -> bool:
    from src.local_data_loader import _parse_filename
    return _parse_filename(filename) is not None


def bars(data_dir: str, symbol: str, tf: str, limit: int = 500) -> Dict[str, Any]:
    """原始 K 线（图表用）。时间统一成 unix 秒，字段名和交易所那条路对齐。"""
    symbol = _safe_token(symbol, "品种")
    tf = _safe_token((tf or "D1").strip().upper(), "周期")
    df = _load_cached(data_dir, symbol, tf)
    limit = max(1, min(int(limit), 20000))
    recent = df.tail(limit).reset_index(drop=True)
    epoch = recent["epoch"].astype("int64").tolist()
    out_bars = [
        {
            "time": int(epoch[i]),
            "open": float(recent["open"].iloc[i]),
            "high": float(recent["high"].iloc[i]),
            "low": float(recent["low"].iloc[i]),
            "close": float(recent["close"].iloc[i]),
            "volume": float(recent["volume"].iloc[i]),
        }
        for i in range(len(recent))
    ]
    return _jsonable({
        "symbol": symbol,
        "tf": std_tf(tf),
        "bars": out_bars,
        "total": len(df),
        "returned": len(out_bars),
    })


def health() -> Dict[str, Any]:
    """引擎自检：模型、校准表、版本都在这里报，界面据此决定哪些列能显示"""
    state = _engine_state()
    return {
        "ok": True,
        "engine": "v3fusion",
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "prob_ready": state["prob_ready"],
        "calibrated": state["calibrated"],
        "prob_meta": state["prob_meta"],
        "calib_meta": state["calib_meta"],
    }
