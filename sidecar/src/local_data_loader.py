"""
本地期货 K 线数据加载器

数据约定：
- 文件命名：{品种名}主连_{周期}.parquet
- 周期代码：D1=日线, W1=周线, M1/M3/M5/M15/M30=分钟, H1/H2/H4=小时
- parquet 列：time(unix秒), open, high, low, close, tick_volume

本加载器将原始数据统一转换为内部 DataFrame：
    date(datetime), open, high, low, close, volume, amount, turn, pct_chg
其中 amount/turn/pct_chg 可缺失（用于兼容 density_analyzer 的可选字段）。
"""

import os
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import pandas as pd


# 周期代码 → 显示名
TIMEFRAME_LABELS = {
    "D1": "日线",
    "W1": "周线",
    "M1": "1分钟",
    "M3": "3分钟",
    "M5": "5分钟",
    "M15": "15分钟",
    "M30": "30分钟",
    "H1": "1小时",
    "H2": "2小时",
    "H4": "4小时",
    # 迁移适配：加密盘口常见 H6/H8/H12，上游表里没有这两档
    "H6": "6小时",
    "H8": "8小时",
    "H12": "12小时",
}

# 多时间框架分析默认使用的周期组
# 本地数据通常没有月线，用 W1 替代月线
MTF_TIMEFRAMES = ["D1", "W1"]

# 周期层级（从小到大），与 config.TF_ORDER 保持一致
_TF_ORDER = ["M1", "M3", "M5", "M15", "M30", "H1", "H2", "H4", "D1", "W1", "MN", "MN1"]

# 每个周期默认分析窗口（K线数）
_TF_WINDOW = {
    "M1": 120, "M3": 120, "M5": 100, "M15": 80, "M30": 60,
    "H1": 60, "H2": 50, "H4": 40, "D1": 40, "W1": 30, "MN": 12, "MN1": 12,
}


def pick_mtf_timeframes(main_tf: str, available_tfs: List[str],
                        up: int = 2, down: int = 2) -> List[Tuple[str, float, int]]:
    """
    自适应选择多时间框架对比的邻居周期。

    根据主周期在周期层级中的位置，向上（更大周期）和向下（更小周期）各取最多
    up / down 个可用邻居。权重规则：
      - 主周期：1.0
      - 向上第 1 个：2.0，第 2 个：3.0（大周期结构更重要，权重递增）
      - 向下：0.5（小周期用于精确入场，权重较低）

    返回: [(tf_code, weight, window), ...]  第一个元素始终是主周期
    """
    available = set(available_tfs)
    if main_tf not in _TF_ORDER:
        return [(main_tf, 1.0, _TF_WINDOW.get(main_tf, 40))]
    idx = _TF_ORDER.index(main_tf)

    result = [(main_tf, 1.0, _TF_WINDOW.get(main_tf, 40))]

    # 向上（更大周期），权重 2、3 递增
    weight = 2.0
    pos = idx + 1
    count = 0
    while pos < len(_TF_ORDER) and count < up:
        t = _TF_ORDER[pos]
        if t in available:
            result.append((t, weight, _TF_WINDOW.get(t, 40)))
            weight += 1.0
            count += 1
        pos += 1

    # 向下（更小周期），权重 0.5
    pos = idx - 1
    count = 0
    while pos >= 0 and count < down:
        t = _TF_ORDER[pos]
        if t in available:
            result.append((t, 0.5, _TF_WINDOW.get(t, 40)))
            count += 1
        pos -= 1

    return result

# 文件名解析（同时兼容三种命名）：
#   1. 期货本地格式：{品种}主连_{周期}.parquet   例如 螺纹钢主连_D1.parquet
#   2. MT5 导出格式：{品种}_{周期}.parquet       例如 EURUSD_H1.parquet、US100.cash_H1.parquet
#   3. 加密盘口格式：{BASE}_{QUOTE}_{周期}.parquet 例如 BTC_USDT_1d.parquet、ETH_USDT_4h.parquet
#
# 迁移适配（不属于上游）：上游的正则只认 [A-Z0-9]+，于是 1d/1h/4h 这类小写写法
# 一个也匹配不上 —— list_instruments 会返回空。这里把周期段放宽成 [A-Za-z0-9]+，
# 再用 _TF_ALIASES 归一成内部标准名（1d→D1、4h→H4、60min→H1），
# 同时记住原始写法，读文件时按原始写法拼路径。支持 .csv 是同样的理由：
# 手上很多数据是 CSV 导出的，列名一样就该能读。
_EXT_PATTERN = r"\.(?:parquet|csv)$"
_FILENAME_PATTERNS = [
    re.compile(r"^(?P<symbol>.+?)主连_(?P<tf>[A-Za-z0-9]+)" + _EXT_PATTERN),
    re.compile(r"^(?P<symbol>.+)_(?P<tf>[A-Za-z0-9]+)" + _EXT_PATTERN),
]

# 文件名周期写法 -> 内部标准周期名。键一律小写比对
_TF_ALIASES = {
    "d1": "D1", "1d": "D1", "daily": "D1", "day": "D1",
    "w1": "W1", "1w": "W1", "weekly": "W1",
    "h1": "H1", "1h": "H1", "60min": "H1", "60m": "H1",
    "h2": "H2", "2h": "H2",
    "h4": "H4", "4h": "H4",
    "h6": "H6", "6h": "H6",
    "h8": "H8", "8h": "H8",
    "h12": "H12", "12h": "H12",
    "m1": "M1", "1m": "M1",
    "m3": "M3", "3m": "M3",
    "m5": "M5", "5m": "M5", "5min": "M5",
    "m15": "M15", "15m": "M15", "15min": "M15",
    "m30": "M30", "30m": "M30", "30min": "M30",
}


def std_tf(raw: str) -> str:
    """把任意周期写法归一成内部标准名；认不出来就原样大写"""
    return _TF_ALIASES.get((raw or "").strip().lower(), (raw or "").strip().upper())

# A股数据集：{6位代码}_{daily|60min|15min|5min}.parquet
# 旧正则用 [A-Z0-9]+ 匹配周期，而 'daily'/'15min' 是小写，因此完全匹配不到，
# 实测 list_instruments(A股目录) 返回 0 个品种。这里单独加一条规则。
_ASHARE_PATTERN = re.compile(r"^(?P<code>\d{6})_(?P<tf>daily|60min|15min|5min)\.parquet$")

# A股周期代码 -> 内部统一周期名（沿用项目既有的 D1/H1/M15/M5 体系）
_ASHARE_TF_TO_STD = {"daily": "D1", "60min": "H1", "15min": "M15", "5min": "M5"}
_STD_TO_ASHARE_TF = {v: k for k, v in _ASHARE_TF_TO_STD.items()}

# 前端会把周期参数 upper() 后传回来（'daily' -> 'DAILY'），
# 因此这里同时接受标准名与 A股 原始名的大小写变体。
_ASHARE_TF_ALIASES = {}
for _raw, _std in _ASHARE_TF_TO_STD.items():
    for _k in (_raw, _raw.upper(), _std, _std.upper()):
        _ASHARE_TF_ALIASES[_k] = _raw


def ashare_tf_file(tf: str) -> Optional[str]:
    """把任意周期写法归一成 A股 文件名里的周期段；非 A股 周期返回 None"""
    return _ASHARE_TF_ALIASES.get((tf or "").strip())


def _parse_filename(filename: str) -> Optional[Tuple[str, str, str]]:
    """
    从文件名解析 (品种, 标准周期名, 周期原始写法)；不匹配返回 None。

    第三个元素是文件里真正的那段写法（'1d' / 'D1' / 'daily'），
    拼文件路径要用它 —— 归一之后的标准名不一定出现在文件名里。
    """
    m = _ASHARE_PATTERN.match(filename)
    if m:
        raw = m.group("tf")
        return m.group("code"), _ASHARE_TF_TO_STD[raw], raw
    for pat in _FILENAME_PATTERNS:
        m = pat.match(filename)
        if m:
            raw = m.group("tf")
            return m.group("symbol"), std_tf(raw), raw
    return None


def is_ashare_dir(data_dir: str) -> bool:
    """目录是否为 A股数据集（存在至少一个 {6位代码}_{周期}.parquet）"""
    if not os.path.isdir(data_dir):
        return False
    try:
        for fn in os.listdir(data_dir):
            if _ASHARE_PATTERN.match(fn):
                return True
    except OSError:
        pass
    return False


def list_instruments(data_dir: str) -> Dict[str, List[str]]:
    """
    扫描数据文件夹，返回 {品种: [可用周期列表]}

    例：{'螺纹钢': ['D1','W1','H1','M5',...], '沪金':[...]}
    """
    result: Dict[str, List[str]] = {}
    if not os.path.isdir(data_dir):
        return result
    for fn in os.listdir(data_dir):
        if not fn.lower().endswith((".parquet", ".csv")):
            continue
        parsed = _parse_filename(fn)
        if not parsed:
            continue
        symbol, tf, _raw = parsed
        result.setdefault(symbol, []).append(tf)
    # 每个品种的周期按固定顺序排序
    order = {tf: i for i, tf in enumerate(
        ["D1", "W1", "H1", "H2", "H4", "H6", "H8", "H12", "M30", "M15", "M5", "M3", "M1"])}
    for symbol in result:
        result[symbol].sort(key=lambda t: order.get(t, 99))
    # 品种按名称排序
    return {s: result[s] for s in sorted(result.keys())}


def _file_index(data_dir: str) -> Dict[Tuple[str, str], str]:
    """
    目录索引：(品种, 标准周期) -> 真实文件名。

    为什么不靠「拼路径再试」：调用方传进来的周期已经是标准名（D1），
    而文件里可能是 1d —— 拼出来的 BTC_USDT_D1.parquet 根本不存在。
    枚举一遍目录、用 _parse_filename 归一，才能把标准名和原始写法对上。
    """
    idx: Dict[Tuple[str, str], str] = {}
    try:
        names = os.listdir(data_dir)
    except OSError:
        return idx
    for fn in names:
        if not fn.lower().endswith((".parquet", ".csv")):
            continue
        parsed = _parse_filename(fn)
        if not parsed:
            continue
        symbol, tf_std, _raw = parsed
        idx.setdefault((symbol, tf_std), fn)
        # 品种名大小写对不上时也能命中
        idx.setdefault((symbol.lower(), tf_std), fn)
        idx.setdefault((symbol.upper(), tf_std), fn)
    return idx


def _filepath(data_dir: str, symbol: str, tf: str, tf_raw: Optional[str] = None) -> str:
    """
    返回实际存在的 K 线文件路径（兼容三种命名、两种扩展名）。

    先按目录索引精确命中 (品种, 标准周期)；再退回「按传入写法拼路径」的老办法，
    最后返回期货格式的 .parquet 路径，让报错文案保持和上游一致。
    """
    tf_std = std_tf(tf)
    idx = _file_index(data_dir)
    for key in ((symbol, tf_std), (symbol.lower(), tf_std), (symbol.upper(), tf_std)):
        hit = idx.get(key)
        if hit:
            return os.path.join(data_dir, hit)

    suffixes = [s for s in (tf_raw, tf) if s]
    stems = []
    for suf in suffixes:
        stems.append(f"{symbol}主连_{suf}")
        stems.append(f"{symbol}_{suf}")
    for stem in stems:
        for ext in (".parquet", ".csv"):
            p = os.path.join(data_dir, stem + ext)
            if os.path.exists(p):
                return p
    # 大小写不敏感回退：Linux 上文件名大小写常和调用方对不上
    want = {s.lower() for s in stems}
    try:
        for fn in os.listdir(data_dir):
            stem = os.path.splitext(fn)[0]
            if stem.lower() in want:
                return os.path.join(data_dir, fn)
    except OSError:
        pass
    return os.path.join(data_dir, f"{symbol}主连_{suffixes[0] if suffixes else tf}.parquet")


def _to_seconds(col: pd.Series) -> pd.Series:
    """
    把数值型时间列换算成 unix 秒（float）。

    上游只认「unix 秒」。实际数据里三种写法都常见：毫秒（1e12 量级）、
    秒（1e9 量级）、以及 A 股导出那种「unix 秒 / 1000」（1e6 量级）。
    这里按**整列中位数的量级**判一次，整列同口径 —— 逐行猜会闹出
    「前半列乘 1000、后半列当秒」的时间轴错乱。
    """
    v = pd.to_numeric(col, errors="coerce")
    mid = float(v.abs().median()) if v.notna().any() else 0.0
    if mid > 1e12:
        return v / 1000.0
    if mid > 1e9:
        return v
    return v * 1000.0


def _to_datetime(col: pd.Series) -> pd.Series:
    """unix 秒 -> 东八区墙上时间（naive）。图表用 epoch，人看的是这一列"""
    sec = _to_seconds(col)
    return pd.to_datetime(sec, unit="s", utc=True).dt.tz_convert(
        "Asia/Shanghai").dt.tz_localize(None)


def _epoch_seconds(ts: pd.Series) -> pd.Series:
    """
    naive datetime（按东八区解释）-> unix 秒。

    为什么不直接 astype("int64")：pandas 3 起 datetime 的内部单位不再固定是纳秒
    （实测是微秒），拿 1e9 去除会得到「秒 ÷ 1000」—— 明明是 2020 年的数据，
    读出来是 1970 年。用 Timedelta 相减，单位由 pandas 自己管。
    """
    aware = ts
    if getattr(ts.dt, "tz", None) is None:
        aware = ts.dt.tz_localize("Asia/Shanghai")
    delta = aware.dt.tz_convert("UTC") - pd.Timestamp("1970-01-01", tz="UTC")
    return (delta // pd.Timedelta(seconds=1)).astype("int64")


def load_kline(data_dir: str, symbol: str, tf: str) -> pd.DataFrame:
    """
    读取单个品种指定周期的 K 线，返回统一格式 DataFrame

    返回列：date(datetime64[ns]), open, high, low, close, volume
    额外列（可选）：amount=0, turn=0, pct_chg(自动计算)

    参数:
        data_dir: 数据文件夹
        symbol:   品种名（不含"主连"后缀）
        tf:       周期代码，如 'D1'/'W1'/'M5'
    """
    # A股数据集：走 srlab 的适配 + 复权路径
    # 本地 A股 parquet 实测为**不复权**（time 单位是 unix秒/1000，volume 单位是手），
    # 历史含 -20% ~ -57% 的除权跳空，直接拿来算成交量剖面/枢轴/ATR 全是错的。
    # 界面用前复权(qfq)，使最新价 = 真实市价。
    _a_tf = ashare_tf_file(tf)
    if _a_tf and _ASHARE_PATTERN.match(f"{symbol}_{_a_tf}.parquet") and \
            os.path.exists(os.path.join(data_dir, f"{symbol}_{_a_tf}.parquet")):
        return _load_ashare(data_dir, symbol, _a_tf)

    path = _filepath(data_dir, symbol, tf)
    if not os.path.exists(path):
        raise FileNotFoundError(f"找不到数据文件: {path}")

    df = pd.read_csv(path) if path.lower().endswith(".csv") else pd.read_parquet(path)

    # 兼容列名：tick_volume → volume
    if "tick_volume" in df.columns and "volume" not in df.columns:
        df = df.rename(columns={"tick_volume": "volume"})

    # time (unix秒) → datetime + epoch
    if "time" in df.columns:
        # 数值型 unix 时间戳
        if pd.api.types.is_numeric_dtype(df["time"]):
            sec = _to_seconds(df["time"])
            df["epoch"] = sec.round().astype("int64")
            df["date"] = pd.to_datetime(df["epoch"], unit="s", utc=True).dt.tz_convert(
                "Asia/Shanghai").dt.tz_localize(None)
        else:
            df["date"] = pd.to_datetime(df["time"])
            df["epoch"] = _epoch_seconds(df["date"])
    elif "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
        df["epoch"] = _epoch_seconds(df["date"])
    else:
        raise ValueError(f"文件 {path} 缺少 time/date 列")

    # 确保所需列存在
    required = ["open", "high", "low", "close", "volume"]
    for c in required:
        if c not in df.columns:
            raise ValueError(f"文件 {path} 缺少列: {c}")

    # 转数值
    for c in required:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # 过滤无效行
    df = df.dropna(subset=required)
    df = df[df["volume"] > 0].copy()
    # 结构性坏行（high<low、价格为 0）：交易所导出和手工 CSV 里都见过。
    # 上游通用分支没有这一步，是 A 股分支 _finalize 才做的；加密/期货数据同样会脏，
    # 这里补上，口径与 _finalize 一致。
    df = df[(df["high"] >= df["low"])
            & (df["low"] > 0)
            & (df["high"] >= df["open"]) & (df["high"] >= df["close"])
            & (df["low"] <= df["open"]) & (df["low"] <= df["close"])].copy()

    # 可选字段填充（density_analyzer 不强制要求）
    if "amount" not in df.columns:
        df["amount"] = df["close"] * df["volume"]
    if "turn" not in df.columns:
        df["turn"] = 0.0
    # 涨跌幅 %
    if "pct_chg" not in df.columns:
        df["pct_chg"] = df["close"].pct_change() * 100
    df["pct_chg"] = df["pct_chg"].fillna(0)

    df.sort_values("date", inplace=True)
    # 同一时间戳只留最后一条：重新导出的文件里常见「旧行 + 新行」并存
    df = df.drop_duplicates(subset="date", keep="last")
    df.reset_index(drop=True, inplace=True)

    # 统一最终列顺序（epoch 是迁移后加的：图表要的是 unix 秒，不要 datetime）
    return df[["date", "epoch", "open", "high", "low", "close", "volume",
               "amount", "turn", "pct_chg"]]


def _load_ashare(data_dir: str, code: str, tf: str) -> pd.DataFrame:
    """
    读取并复权 A股 K 线，返回本模块统一列格式。

    复权策略：优先权威因子缓存（data/adj_factors.parquet）；
    缺失时**降级为不复权，但在 df.attrs 里明确标记**，由界面显示告警。
    与回测路径的差异是有意的：
      - 回测缺因子直接报错（错误的复权数据会污染结论，宁可不跑）
      - 界面缺因子仍然展示，但必须让用户看见"此标的未复权"这个事实
    """
    from src.srlab.data import MissingFactorError, ashare_load

    tf_file = ashare_tf_file(tf) or tf
    try:
        df = ashare_load(data_dir, code, tf_file,
                         adjust="factor", adjust_mode="qfq")
    except MissingFactorError:
        df = ashare_load(data_dir, code, tf_file, adjust="none")
        df.attrs["adjust_warning"] = (
            f"{code} 缺少权威复权因子，当前为**不复权**数据，"
            f"历史除权跳空会影响关键位判定。"
            f"运行 python scripts/build_factors.py 补齐。")
    except FileNotFoundError:
        raise FileNotFoundError(f"找不到数据文件: {code}_{tf_file}.parquet")

    if "turn" not in df.columns:
        df["turn"] = 0.0
    attrs = dict(df.attrs)
    out = df[["date", "open", "high", "low", "close", "volume",
              "amount", "turn", "pct_chg"]].copy()
    # 图表要 unix 秒；复权后的价格与原始时间无关，epoch 不受复权影响
    out["epoch"] = _epoch_seconds(out["date"])
    out.attrs.update(attrs)
    return out


def iter_all_instruments(
    data_dir: str,
    tf: str = "D1",
    symbols: Optional[List[str]] = None,
):
    """
    迭代生成 (symbol, DataFrame)，用于批量分析

    参数:
        data_dir: 数据文件夹
        tf:       使用的周期
        symbols:  限定品种列表；None 表示全部品种
    """
    instruments = list_instruments(data_dir)
    target_symbols = symbols if symbols is not None else list(instruments.keys())
    for symbol in target_symbols:
        available_tfs = instruments.get(symbol, [])
        if tf not in available_tfs:
            continue
        try:
            df = load_kline(data_dir, symbol, tf)
            yield symbol, df
        except Exception as e:
            # 跳过错误文件，继续下一个
            print(f"[跳过] {symbol} ({tf}): {e}")
            continue
