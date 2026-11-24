import { DataError } from '../errors.js';

/**
 * 请求参数的解析与校验。
 *
 * 为什么要有这一层：以前每个处理函数自己写 `String(req.body.contract ?? '')`
 * 和 `Number(req.body.size)` —— 缺字段时拿到的是 '' 或 NaN，然后在下游更远的地方
 * 报一句看不懂的错，或者更糟：NaN 一路当成 0 混过去。二十多处各写一遍，
 * 同一个问题也就有了二十多种说法。
 *
 * 这里只做一件事：**把外部输入变成确定的类型**。业务判断不在这儿 ——
 * 张数够不够、止损站哪边，仍然由各个接口自己说了算。
 *
 * 错误一律是 400 + 字段名 + 期望值，页面直接把这句 detail 显示出来。
 * 标签沿用 BAD_INPUT：老接口原本就用它，前端也不按错误码分支（只认 NOT_ARMED）。
 */

function bad(message: string): DataError {
  return new DataError(400, 'BAD_INPUT', message);
}

/** 请求体必须是对象。express.json 在空请求体时给的是 {}，所以缺省当成空对象 */
export function bodyOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('请求体必须是一个 JSON 对象');
  return value as Record<string, unknown>;
}

const MISSING = Symbol('missing');

/** 数字来源：number 或者数字字符串（页面有时把输入框的值原样发过来） */
function numeric(value: unknown): number | typeof MISSING {
  if (value === undefined || value === null) return MISSING;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return MISSING;
    const n = Number(text);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

export interface NumberOpts {
  min?: number;
  max?: number;
  /** 必须大于 0（张数、价格这类） */
  positive?: boolean;
  integer?: boolean;
}

function checkNumber(n: number, field: string, opts: NumberOpts): number {
  if (!Number.isFinite(n)) throw bad(field + ' 必须是数字');
  if (opts.integer && !Number.isInteger(n)) throw bad(field + ' 必须是整数');
  if (opts.positive && !(n > 0)) throw bad(field + ' 必须大于 0');
  if (opts.min !== undefined && n < opts.min) throw bad(field + ' 不能小于 ' + opts.min);
  if (opts.max !== undefined && n > opts.max) throw bad(field + ' 不能大于 ' + opts.max);
  return n;
}

/** 必填数字 */
export function requiredNumber(value: unknown, field: string, opts: NumberOpts = {}): number {
  const n = numeric(value);
  if (n === MISSING) throw bad('缺少 ' + field);
  return checkNumber(n, field, opts);
}

/** 选填数字：没给就返回 undefined（注意不是 0 —— 0 和「没填」是两件事） */
export function optionalNumber(value: unknown, field: string, opts: NumberOpts = {}): number | undefined {
  const n = numeric(value);
  if (n === MISSING) return undefined;
  return checkNumber(n, field, opts);
}

/** 选填数字，没给就用默认值 */
export function numberOr(value: unknown, field: string, fallback: number, opts: NumberOpts = {}): number {
  const n = numeric(value);
  if (n === MISSING) return fallback;
  return checkNumber(n, field, opts);
}

/** 必填字符串。前后空白会去掉 */
export function requiredText(value: unknown, field: string, opts: { max?: number } = {}): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw bad('缺少 ' + field);
  const text = String(value).trim();
  if (!text) throw bad('缺少 ' + field);
  const max = opts.max ?? 200;
  if (text.length > max) throw bad(field + ' 太长了（最多 ' + max + ' 个字符）');
  return text;
}

/** 选填字符串：没给就返回空串 */
export function textOr(value: unknown, field: string, fallback = '', opts: { max?: number } = {}): string {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const max = opts.max ?? 400;
  if (text.length > max) throw bad(field + ' 太长了（最多 ' + max + ' 个字符）');
  return text;
}

/** 枚举之一。给了不认识的值就报错，而不是悄悄当成第一个 */
export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((allowed as readonly string[]).includes(text)) return text as T;
  throw bad(field + ' 只能是 ' + allowed.join(' / '));
}

/** 枚举之一，没给就用默认值 */
export function oneOfOr<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  return oneOf(value, field, allowed);
}

/** 布尔。字符串 "false" / "0" 也当假 —— 查询串和表单都可能是这种 */
export function flag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  return Boolean(value);
}
