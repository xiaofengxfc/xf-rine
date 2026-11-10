import type { OpenOrder } from './api.ts';

/** 图上一条挂着的限价单 */
export interface OrderLine {
  id: string;
  price: number;
  /** 剩余张数 */
  size: number;
  /** 轴标签：买 3 / 卖 2 */
  label: string;
}

/**
 * 只有还挂着的限价单才画线。
 * 市价单的 price 是 0，它不挂在盘口上，画出来会贴到坐标轴底部；
 * 已成交或已撤掉的也不该在图上留一条找不到主人的线。
 * 张数取剩余量，改过量的单看起来才对。
 */
export function pendingOrderLines(orders: OpenOrder[]): OrderLine[] {
  const out: OrderLine[] = [];
  for (const o of orders) {
    if (o.status !== 'open') continue;
    if (!(o.price > 0)) continue;
    const size = Math.abs(o.left || o.size);
    if (!(size > 0)) continue;
    out.push({
      id: o.id,
      price: o.price,
      size,
      label: `${o.size > 0 ? '买' : '卖'} ${size}`,
    });
  }
  return out;
}
