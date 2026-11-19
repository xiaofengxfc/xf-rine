/**
 * 关键位引擎（Python sidecar）的返回契约。
 *
 * 这些字段名就是上游 src/sr_engine.py 的 _zone_json 输出的名字，一个字都没改 ——
 * 改名字会让「移植」变成「重写」，以后对齐上游版本就无从谈起。
 *
 * 概率相关的说明（上游实测，写在 sr_engine.py 的注释里）：
 *   p_touch   未来 horizon 根内价格走到这个位的概率     AUC 0.73~0.77，区分度强
 *   p_hold    走到之后反弹而不是跌穿的概率              AUC 0.59~0.61，绝对值可信、排序能力弱
 *   p_eff     两者相乘，界面上当作「综合有效概率」排序
 *   bucket    这个位的 edge 分落在历史第几档（Q1~Q5），对应的样本外实测在 bucket_* 里
 */

export type Direction = 'long' | 'short' | 'both';

export interface SidecarBar {
  /** unix 秒 */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Zone {
  p_touch: number | null;
  p_hold: number | null;
  p_effective: number | null;
  center: number;
  low: number;
  high: number;
  zone_type: 'support' | 'resistance';
  zone_label: string;
  distance_pct: number;
  distance_atr: number;
  width_atr: number;
  width_pct: number | null;
  edge_score: number;
  n_events: number;
  stale: number;
  p_stall: number;
  stall_bucket: string | null;
  vp_strength: number;
  bucket: string | null;
  bucket_hold_rate: number | null;
  bucket_fwd_ret: number | null;
  bucket_n: number | null;
  tf_count: number;
  tfs: string;
  /**
   * 本地加的字段，上游引擎没有：这条位是「之前出现过、这次没重算出来」的历史位。
   * 只影响页面怎么画（画淡一点），不参与任何数值含义。
   */
  history?: boolean;
  /**
   * 本地加的字段：这条位来自邻居周期（例如「4 小时」），不是本周期算出来的。
   * 用于给图上标注写清出处，不参与任何数值含义。
   */
  from_tf?: string;
}

export interface AnalysisSummary {
  direction: string;
  direction_label: string;
  nearest: Zone | null;
  best: Zone | null;
  trend_label: string;
  trend_detail: string;
  headline: string;
  caveat: string;
}

export interface EngineInfo {
  atr: number;
  atr_pct: number | null;
  calibrated: boolean;
  calib_meta: Record<string, unknown>;
  prob_ready: boolean;
  prob_meta: Record<string, unknown>;
  adjust_mode?: string;
  adjust_source?: string;
  n_ex_rights?: number;
  adjust_warning?: string | null;
}

export interface MtfGroup {
  tf: string;
  tf_label: string;
  zones: Zone[];
}

export interface KlineSeries {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface Analysis {
  symbol: string;
  symbol_label: string;
  tf: string;
  tf_label: string;
  current_price: number;
  change_pct: number;
  window: number;
  n_zones: number;
  data_bars: number;
  zones: Zone[];
  mtf_zones: MtfGroup[];
  summary: AnalysisSummary;
  engine: EngineInfo;
  direction: string;
  direction_label: string;
  kline?: KlineSeries;
  kline_total: number;
}

export interface ScanRow {
  symbol: string;
  tf: string;
  current_price: number;
  change_pct: number;
  n_zones: number;
  nearest_support: number | null;
  nearest_support_dist_pct: number | null;
  nearest_resistance: number | null;
  nearest_resistance_dist_pct: number | null;
  p_touch: number | null;
  p_hold: number | null;
  p_effective: number | null;
  edge_score: number | null;
  n_events: number | null;
  width_atr: number | null;
  nearest_distance_pct: number | null;
  nearest_distance_atr: number | null;
  bucket: string | null;
  p_stall: number | null;
  trend_label: string;
  direction: string;
  data_bars: number;
  atr_pct: number | null;
  adjusted: boolean;
  adjust_source: string | null;
}

export interface ScanSummary {
  total: number;
  analyzed: number;
  failed: number;
  n_adjusted: number;
  n_unadjusted: number;
  tf: string;
  tf_label: string;
  window: number;
  n_zones: number;
  direction: string;
  direction_label: string;
  data_dir: string;
  calibrated: boolean;
  prob_ready: boolean;
}

export interface ScanResult {
  summary: ScanSummary;
  rows: ScanRow[];
  errors: { symbol: string; reason: string }[];
}

export interface Instrument {
  symbol: string;
  timeframes: string[];
}

export interface InstrumentsResult {
  data_dir: string;
  count: number;
  instruments: Instrument[];
  tf_labels: Record<string, string>;
}

export interface SidecarHealth {
  ok: boolean;
  engine: string;
  python: string;
  numpy: string;
  prob_ready: boolean;
  calibrated: boolean;
  prob_meta: Record<string, unknown>;
  calib_meta: Record<string, unknown>;
}
