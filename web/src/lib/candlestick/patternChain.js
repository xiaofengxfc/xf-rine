import * as hammer from "./hammer.js";
import * as invertedHammer from "./invertedHammer.js";
import * as engulfing from "./engulfing.js";
import * as harami from "./harami.js";
import * as kicker from "./kicker.js";
import * as reversal from "./reversal.js";
import * as doji from "./doji.js";
import * as morningStar from "./morningStar.js";
import * as eveningStar from "./eveningStar.js";
import * as threeWhiteSoldiers from "./threeWhiteSoldiers.js";
import * as threeBlackCrows from "./threeBlackCrows.js";
import * as piercingLine from "./piercingLine.js";
import * as darkCloudCover from "./darkCloudCover.js";
import * as marubozu from "./marubozu.js";
import * as spinningTop from "./spinningTop.js";
import * as tweezers from "./tweezers.js";

const allPatterns = [
  { name: "hammer", fn: hammer.hammer, paramCount: 1 },
  { name: "bullishHammer", fn: hammer.bullishHammer, paramCount: 1 },
  { name: "bearishHammer", fn: hammer.bearishHammer, paramCount: 1 },
  { name: "invertedHammer", fn: invertedHammer.invertedHammer, paramCount: 1 },
  {
    name: "bullishInvertedHammer",
    fn: invertedHammer.bullishInvertedHammer,
    paramCount: 1,
  },
  {
    name: "bearishInvertedHammer",
    fn: invertedHammer.bearishInvertedHammer,
    paramCount: 1,
  },
  { name: "bullishEngulfing", fn: engulfing.bullishEngulfing, paramCount: 2 },
  { name: "bearishEngulfing", fn: engulfing.bearishEngulfing, paramCount: 2 },
  { name: "bullishHarami", fn: harami.bullishHarami, paramCount: 2 },
  { name: "bearishHarami", fn: harami.bearishHarami, paramCount: 2 },
  { name: "bullishKicker", fn: kicker.bullishKicker, paramCount: 2 },
  { name: "bearishKicker", fn: kicker.bearishKicker, paramCount: 2 },
  { name: "hangingMan", fn: reversal.hangingMan, paramCount: 2 },
  { name: "shootingStar", fn: reversal.shootingStar, paramCount: 2 },
  { name: "piercingLine", fn: piercingLine.piercingLine, paramCount: 2 },
  { name: "darkCloudCover", fn: darkCloudCover.darkCloudCover, paramCount: 2 },
  { name: "doji", fn: doji.doji, paramCount: 1 },
  { name: "morningStar", fn: morningStar.morningStar, paramCount: 3 },
  { name: "eveningStar", fn: eveningStar.eveningStar, paramCount: 3 },
  {
    name: "threeWhiteSoldiers",
    fn: threeWhiteSoldiers.threeWhiteSoldiers,
    paramCount: 3,
  },
  {
    name: "threeBlackCrows",
    fn: threeBlackCrows.threeBlackCrows,
    paramCount: 3,
  },
  { name: "marubozu", fn: marubozu.marubozu, paramCount: 1 },
  { name: "bullishMarubozu", fn: marubozu.bullishMarubozu, paramCount: 1 },
  { name: "bearishMarubozu", fn: marubozu.bearishMarubozu, paramCount: 1 },
  { name: "spinningTop", fn: spinningTop.spinningTop, paramCount: 1 },
  {
    name: "bullishSpinningTop",
    fn: spinningTop.bullishSpinningTop,
    paramCount: 1,
  },
  {
    name: "bearishSpinningTop",
    fn: spinningTop.bearishSpinningTop,
    paramCount: 1,
  },
  { name: "tweezersTop", fn: tweezers.tweezersTop, paramCount: 2 },
  { name: "tweezersBottom", fn: tweezers.tweezersBottom, paramCount: 2 },
];

import { ensurePrecomputed } from "./utils.js";
import { applyTrendContext } from "./trendContext.js";

/**
 * @typedef {import("./trendContext.js").TrendContextOptions} TrendContextOptions
 */

/**
 * Scans a candlestick series for a sequence of patterns.
 * @param {Array<Object>} candles - Array of candlesticks
 * @param {Array<{name: string, fn: function}>} patterns - Array of pattern objects
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - Throw on invalid OHLC data instead of silently skipping.
 * @param {TrendContextOptions} [options.trendContext] - Opt-in trend-context confidence adjustment (#95). Omit entirely to preserve pre-existing output shape exactly.
 * @returns {Array<{ index: number, pattern: string, match: Object|Array<Object>, trendContext?: "uptrend"|"downtrend"|"sideways", contextFit?: number }>} Array of matches
 */
function patternChain(
  candles,
  patterns = allPatterns,
  { strict = false, trendContext } = {},
) {
  const precomputed = ensurePrecomputed(candles, strict);
  const results = [];
  for (const pattern of patterns) {
    const { name, fn, paramCount = 1 } = pattern;
    const indices = fn(precomputed);
    for (const idx of indices) {
      const match = precomputed.slice(idx, idx + paramCount);
      results.push({ index: idx, pattern: name, match });
    }
  }
  // Sort by index for chronological order
  results.sort((a, b) => a.index - b.index);

  if (trendContext) {
    return applyTrendContext(precomputed, results, trendContext);
  }

  return results;
}

export {
  patternChain,
  allPatterns,
};
