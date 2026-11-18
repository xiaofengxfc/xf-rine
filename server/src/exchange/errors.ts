/**
 * 交易所报错。
 *
 * 类名仍然是 GateError：项目里几十处 instanceof / catch 都按这个类判，
 * 改名换不来任何好处，只会把每一处都碰一遍。真正带出去的字符串由 `from` 决定，
 * 现在可能是 Gate，也可能是 Bitget —— 报错里写错交易所名，比不写更糟。
 */
export class GateError extends Error {
  status: number;
  label: string;
  detail: string;
  /** 哪个交易所报的。空字符串表示与交易所无关（参数错、缺密钥这类） */
  from: string;

  constructor(status: number, label: string, detail: string, from = '') {
    super(from ? `${from} ${status} ${label}: ${detail}` : `${status} ${label}: ${detail}`);
    this.name = 'GateError';
    this.status = status;
    this.label = label;
    this.detail = detail;
    this.from = from;
  }
}
