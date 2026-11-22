import type { OpenOrder, Position, PriceOrder, Zone } from '../src/lib/api.ts';
import { buildChartPriceLines, type ChartPriceLineInput } from '../src/hooks/useChartPriceLines.ts';

let failures = 0;

function check(name: string, passed: boolean): void {
  if (passed) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.error('  ✗ ' + name);
  }
}

function position(direction: Position['direction'], entryPrice: number): Position {
  return {
    contract: 'BTC_USDT',
    size: 1,
    direction,
    leverage: 10,
    entryPrice,
    markPrice: 100,
    liqPrice: 0,
    unrealisedPnl: 0,
    value: 100,
    mode: 'single',
    marginMode: 'isolated',
    multiplier: 1,
  };
}

function zone(center: number, history = false, zoneType: Zone['zone_type'] = 'support'): Zone {
  return {
    p_touch: 0.7,
    p_hold: 0.8,
    p_effective: 0.56,
    center,
    low: center - 1,
    high: center + 1,
    zone_type: zoneType,
    zone_label: zoneType === 'support' ? '支撑' : '阻力',
    distance_pct: 0,
    distance_atr: 0,
    width_atr: 1,
    width_pct: 2,
    edge_score: 1,
    n_events: 3,
    stale: 0,
    p_stall: 0,
    stall_bucket: null,
    vp_strength: 1,
    bucket: null,
    bucket_hold_rate: null,
    bucket_fwd_ret: null,
    bucket_n: null,
    history,
    tf_count: 1,
    tfs: '15m',
  };
}

const orders: OpenOrder[] = [{
  id: 'limit-1',
  contract: 'BTC_USDT',
  size: 2,
  left: 1,
  price: 97,
  fillPrice: 0,
  status: 'open',
  reduceOnly: false,
  createTime: 1,
  tif: 'gtc',
}];

const priceOrders: PriceOrder[] = [
  {
    id: 'stop-1', contract: 'BTC_USDT', direction: 'long', triggerPrice: 90,
    triggerRule: 2, size: 1, protective: true, reduceOnly: true,
    closeAll: true, createTime: 1, expiresAt: 0,
  },
  {
    id: 'target-1', contract: 'BTC_USDT', direction: 'long', triggerPrice: 110,
    triggerRule: 1, size: 1, protective: true, reduceOnly: true,
    closeAll: true, createTime: 1, expiresAt: 0,
  },
];

const input: ChartPriceLineInput = {
  positions: [position('long', 95), position('short', 105)],
  orders,
  priceOrders,
  zones: [zone(98), zone(96, true), zone(102, false, 'resistance')],
  bars: [{ time: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 }],
  account: null,
  markPrice: 100,
  stale: true,
  priceRound: 0.1,
};

const lines = buildChartPriceLines(input);
const hasTitle = (title: string) => lines.some((line) => line.title === title);

check('双向持仓分别标出多空成本和估算强平价',
  hasTitle('多单均价')
  && hasTitle('空单均价')
  && hasTitle('预估多单强平 ≈ 85.5')
  && hasTitle('预估空单强平 ≈ 115.5'));
check('止损止盈按持仓方向标注，限价单显示剩余张数',
  hasTitle('多单止损 90.0')
  && hasTitle('多单止盈 110.0')
  && hasTitle('买 1'));
check('历史位不显示文字或轴价格，当前位显示概率文字',
  lines.some((line) => line.title.includes('支撑 98.0') && line.axisLabelVisible)
  && lines.some((line) => line.title.includes('阻力 102.0') && line.axisLabelVisible)
  && lines.some((line) => line.price === 96 && line.title === '' && line.axisLabelVisible === false));
const compactLines = buildChartPriceLines(input, true);
check('手机支撑阻力线只显示类别，当前价位仍显示在轴标签',
  compactLines.some((line) => line.price === 98 && line.title === '支撑' && line.axisLabelVisible)
  && compactLines.some((line) => line.price === 102 && line.title === '阻力' && line.axisLabelVisible)
  && compactLines.some((line) => line.price === 96 && line.title === '' && line.axisLabelVisible === false));
check('叠加线按绘制优先级排序',
  lines.every((line, index) => index === 0 || lines[index - 1]!.rank <= line.rank));

if (failures) process.exit(1);
console.log('✓ 图表价位线生成检查通过');
