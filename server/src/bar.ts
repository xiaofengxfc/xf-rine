/**
 * 一根 K 线。服务端内部各处（交易所时间轴、AI 快照、发给引擎的 frames）共用这一个形状。
 *
 * 时间一律是 unix 秒。以前它定义在 levels.ts 里，算法搬到 Python 之后，
 * 这个纯数据形状单独留在这里，免得为了一个接口类型去依赖被删掉的文件。
 */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 计价币成交额。图表展示用，不替代算法使用的原始 volume */
  turnover?: number;
}
