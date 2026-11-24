/**
 * 形态实测统计。**这个文件是脚本生成的，别手改。**
 *
 * 生成命令：pnpm stats:patterns（脚本在 web/scripts/pattern-stats.ts）
 * 数据源：Gate 永续公开 K 线（api.gateio.ws）
 * 样本：BTC_USDT / ETH_USDT / DOGE_USDT / SOL_USDT，周期 5m / 15m / 1h / 4h / 1d，按 全部周期合并统计
 * 区间：2019-11-18 00:00 ~ 2026-11-22 15:00 UTC，共 70456 根
 *
 * **这份表是折外结果。** 3 折滚动：每折只在训练段上选形态，在之后的测试段上验，
 * 下面列的是各折测试段合并后的表现 —— 选的时候没见过的数据。
 *
 * 口径：第 i 根收盘确认，持有 1/3/5 根（主口径 3）；收益按方向对齐后
 * 除以当根 ATR/收盘价。base 是同一样本里「随便挑一根、按同一方向做」的正确率，
 * excess = win − base 才是这个形态的增量。q 是 Benjamini-Hochberg 校正后的假发现率。
 * tier 0 = 样本不足或校正后没有增量，1~3 = 增量越显著越高。
 *
 * 注意：tier **不是**上不上图的门槛。实测一个形态都过不了线，按门槛筛会让整个开关变成
 * 死功能。界面只按 tier 决定稀疏程度和排序；标记画的是教科书的涨跌方向（见 patterns.ts）。
 */

export type StatTier = 0 | 1 | 2 | 3;

export interface PatternStat {
  /** 样本数（形态命中次数） */
  n: number;
  /** 方向正确率（主口径持有 3 根） */
  win: number;
  /** 同一样本、同方向的基准正确率 */
  base: number;
  /** win − base */
  excess: number;
  /** 单尾 z */
  z: number;
  /** BH 校正后的假发现率 */
  q: number;
  /** 以 ATR 为单位的平均方向收益（主口径，单笔夹在 ±10 以内） */
  edgeAtr: number;
  /** 各持有期的正确率，按 HORIZONS 顺序 */
  winByHorizon: number[];
  tier: StatTier;
}

/** 口径 key（默认 all = 所有周期合并）→ 形态 id → 统计 */
export const PATTERN_STATS: Record<string, Record<string, PatternStat>> = {
  "all": {
    "bearishHarami": {"n":3180,"win":0.5287,"base":0.5121,"excess":0.0166,"z":1.87,"q":0.37,"edgeAtr":0.073,"winByHorizon":[0.516,0.5287,0.5329],"tier":0},
    "bullishHarami": {"n":3137,"win":0.5053,"base":0.4879,"excess":0.0174,"z":1.94,"q":0.37,"edgeAtr":-0.037,"winByHorizon":[0.5003,0.5053,0.5048],"tier":0},
    "bearishEngulfing": {"n":2967,"win":0.4761,"base":0.5121,"excess":-0.036,"z":-3.91,"q":1,"edgeAtr":0.034,"winByHorizon":[0.4834,0.4761,0.4856],"tier":0},
    "bullishEngulfing": {"n":2935,"win":0.4551,"base":0.4879,"excess":-0.0328,"z":-3.54,"q":1,"edgeAtr":-0.036,"winByHorizon":[0.4449,0.4551,0.4617],"tier":0},
    "hammer": {"n":1804,"win":0.466,"base":0.4879,"excess":-0.0219,"z":-1.86,"q":1,"edgeAtr":-0.103,"winByHorizon":[0.4698,0.466,0.446],"tier":0},
    "invertedHammer": {"n":1667,"win":0.4861,"base":0.4879,"excess":-0.0018,"z":-0.15,"q":1,"edgeAtr":-0.058,"winByHorizon":[0.4939,0.4861,0.4691],"tier":0},
    "bearishHammer": {"n":994,"win":0.4747,"base":0.4879,"excess":-0.0132,"z":-0.83,"q":1,"edgeAtr":-0.097,"winByHorizon":[0.4787,0.4747,0.4677],"tier":0},
    "bullishInvertedHammer": {"n":868,"win":0.4907,"base":0.4879,"excess":0.0028,"z":0.17,"q":1,"edgeAtr":-0.046,"winByHorizon":[0.4965,0.4907,0.4861],"tier":0},
    "bullishHammer": {"n":807,"win":0.4544,"base":0.4879,"excess":-0.0335,"z":-1.9,"q":1,"edgeAtr":-0.114,"winByHorizon":[0.4581,0.4544,0.4182],"tier":0},
    "bearishInvertedHammer": {"n":795,"win":0.4785,"base":0.4879,"excess":-0.0094,"z":-0.53,"q":1,"edgeAtr":-0.076,"winByHorizon":[0.4886,0.4785,0.4491],"tier":0},
    "bullishMarubozu": {"n":671,"win":0.4406,"base":0.4879,"excess":-0.0473,"z":-2.44,"q":1,"edgeAtr":-0.061,"winByHorizon":[0.4551,0.4406,0.4865],"tier":0},
    "bearishMarubozu": {"n":661,"win":0.4985,"base":0.5121,"excess":-0.0136,"z":-0.7,"q":1,"edgeAtr":0.065,"winByHorizon":[0.4663,0.4985,0.497],"tier":0},
    "tweezersTop": {"n":173,"win":0.5714,"base":0.5121,"excess":0.0593,"z":1.54,"q":0.4956,"edgeAtr":0.177,"winByHorizon":[0.5318,0.5714,0.5465],"tier":0},
    "tweezersBottom": {"n":164,"win":0.4321,"base":0.4879,"excess":-0.0558,"z":-1.42,"q":1,"edgeAtr":-0.021,"winByHorizon":[0.4568,0.4321,0.454],"tier":0},
    "morningStar": {"n":44,"win":0.4286,"base":0.4879,"excess":-0.0593,"z":-0.77,"q":1,"edgeAtr":-0.389,"winByHorizon":[0.2381,0.4286,0.4186],"tier":0},
    "bearishKicker": {"n":28,"win":0.3571,"base":0.5121,"excess":-0.155,"z":-1.64,"q":1,"edgeAtr":-0.46,"winByHorizon":[0.3571,0.3571,0.2593],"tier":0},
    "threeBlackCrows": {"n":26,"win":0.36,"base":0.5121,"excess":-0.1521,"z":-1.52,"q":1,"edgeAtr":-0.409,"winByHorizon":[0.3462,0.36,0.4615],"tier":0},
    "eveningStar": {"n":25,"win":0.2,"base":0.5121,"excess":-0.3121,"z":-3.12,"q":1,"edgeAtr":-0.537,"winByHorizon":[0.2083,0.2,0.2],"tier":0},
    "bullishKicker": {"n":22,"win":0.381,"base":0.4879,"excess":-0.107,"z":-0.98,"q":1,"edgeAtr":-0.15,"winByHorizon":[0.4091,0.381,0.5455],"tier":0},
    "threeWhiteSoldiers": {"n":20,"win":0.5,"base":0.4879,"excess":0.0121,"z":0.11,"q":1,"edgeAtr":0.02,"winByHorizon":[0.55,0.5,0.6],"tier":0},
    "darkCloudCover": {"n":9,"win":0.5556,"base":0.5121,"excess":0.0435,"z":0.26,"q":1,"edgeAtr":0.313,"winByHorizon":[0.6667,0.5556,0.5556],"tier":0},
    "shootingStar": {"n":7,"win":0.2857,"base":0.5121,"excess":-0.2264,"z":-1.2,"q":1,"edgeAtr":-0.18,"winByHorizon":[0.5714,0.2857,0.5714],"tier":0},
    "piercingLine": {"n":7,"win":0.2857,"base":0.4879,"excess":-0.2022,"z":-1.07,"q":1,"edgeAtr":-0.016,"winByHorizon":[0.5,0.2857,0.4286],"tier":0},
    "hangingMan": {"n":2,"win":1,"base":0.5121,"excess":0.4879,"z":1.38,"q":0.5024,"edgeAtr":0.764,"winByHorizon":[0.5,1,1],"tier":0},
  },
};

export const TREND_SENSITIVITY: Record<string, number> = {
  "5m": 1250.7,
  "15m": 1039.52,
  "1h": 500.33,
  "4h": 179.96,
  "1d": 54.52,
};

/** 生成时用的样本和折法，界面和自检都从这里读口径 */
export const PATTERN_STATS_SAMPLE = {
  "key": "all",
  "symbols": [
    "BTC_USDT",
    "ETH_USDT",
    "DOGE_USDT",
    "SOL_USDT"
  ],
  "intervals": [
    "5m",
    "15m",
    "1h",
    "4h",
    "1d"
  ],
  "bars": 70456,
  "from": "2019-11-18 00:00",
  "to": "2026-11-22 15:00",
  "horizons": [
    1,
    3,
    5
  ],
  "primaryHorizon": 3,
  "minSamples": 100,
  "fdr": 0.1,
  "minExcess": 0.02,
  "folds": 3,
  "fade": false,
  "source": "gate-futures"
};
