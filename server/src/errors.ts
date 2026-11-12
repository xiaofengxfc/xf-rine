/**
 * 数据层 / 参数错误的统一形状。
 *
 * label 给前端当错误码用（页面按它决定提示什么），message 给人看。
 * 原来它住在 localdata.ts 里；本地数据改由 Python 引擎读之后，那个文件没了，
 * 但错误形状是整个服务端共用的，单独留一份。
 */
export class DataError extends Error {
  status: number;
  label: string;
  constructor(status: number, label: string, message: string) {
    super(message);
    this.name = 'DataError';
    this.status = status;
    this.label = label;
  }
}
