/** Offline checks for Bitget UTA response mappings and order direction. */
import {
  bitgetAccountSnapshot,
  bitgetOrderSide,
  bitgetUtaOrderSide,
  mapBitgetPosition,
  mapBitgetStrategyTriggers,
  mapBitgetUtaOrder,
  signedBitgetOrderSize,
} from '../src/bitget/adapter.js';

const checks: [string, unknown, unknown][] = [
  ['hedge open long', bitgetOrderSide('hedge_mode', 'long', false), 'buy'],
  ['hedge close long keeps position side', bitgetOrderSide('hedge_mode', 'long', true), 'buy'],
  ['hedge open short', bitgetOrderSide('hedge_mode', 'short', false), 'sell'],
  ['hedge close short keeps position side', bitgetOrderSide('hedge_mode', 'short', true), 'sell'],
  ['one-way open long', bitgetOrderSide('one_way_mode', 'long', false), 'buy'],
  ['one-way close long', bitgetOrderSide('one_way_mode', 'long', true), 'sell'],
  ['one-way open short', bitgetOrderSide('one_way_mode', 'short', false), 'sell'],
  ['one-way close short', bitgetOrderSide('one_way_mode', 'short', true), 'buy'],
  ['buy order signed positive', signedBitgetOrderSize('buy', 0.01, 0.001), 10],
  ['sell order signed negative', signedBitgetOrderSize('sell', 0.01, 0.001), -10],
  ['UTA hedge close long uses sell side', bitgetUtaOrderSide('hedge_mode', 'long', true), 'sell'],
  ['UTA hedge close short uses buy side', bitgetUtaOrderSide('hedge_mode', 'short', true), 'buy'],
  ['UTA hedge open long uses buy side', bitgetUtaOrderSide('hedge_mode', 'long', false), 'buy'],
  ['map account equity and availability', JSON.stringify(bitgetAccountSnapshot({
    marginCoin: 'USDT', accountEquity: '125.5', available: '100', unrealizedPL: '2.5',
  })), JSON.stringify({ total: 125.5, available: 100, unrealised_pnl: 2.5, currency: 'USDT' })],
  ['map simulator equity field', bitgetAccountSnapshot({ marginCoin: 'USDT', equity: '88', available: '80', unrealizedPL: '-1' }).total, 88],
  ['map USDT equity and available margin in union mode', JSON.stringify(bitgetAccountSnapshot({ assetMode: 'union', accountEquity: '0', usdtEquity: '125.5', available: '0', unionAvailable: '100' })), JSON.stringify({ total: 125.5, available: 100, unrealised_pnl: 0, currency: 'USDT' })],
  ['map UTA account assets', JSON.stringify(bitgetAccountSnapshot({ accountEquity: '4994.725', usdtEquity: '5000', effEquity: '4994.72499999', usdtUnrealisedPnl: '0', assets: [{ coin: 'USDT', equity: '5000', balance: '5000', available: '5000', locked: '0' }] })), JSON.stringify({ total: 5000, available: 5000, unrealised_pnl: 0, currency: 'USDT' })],
  ['skip blank account values when falling back', JSON.stringify(bitgetAccountSnapshot({ accountEquity: '', usdtEquity: '88', available: '', unionAvailable: '80' })), JSON.stringify({ total: 88, available: 80, unrealised_pnl: 0, currency: 'USDT' })],
  ['map UTA hedge short position size and margin fields', JSON.stringify(mapBitgetPosition({ symbol: 'BTCUSDT', total: '0.05', holdMode: 'hedge_mode', posSide: 'short', leverage: '5', avgPrice: '100000', markPrice: '99000', liquidationPrice: '120000', marginMode: 'crossed', unrealisedPnl: '-50', curRealisedPnl: '2' }, 0.001)), JSON.stringify({ contract: 'BTC_USDT', size: '50', mode: 'dual_short', leverage: '5', margin_mode: 'crossed', entry_price: '100000', mark_price: '99000', liq_price: '120000', unrealised_pnl: '-50', realised_pnl: '2', value: '4950' })],
  ['map UTA one-way short sign', JSON.stringify(mapBitgetPosition({ symbol: 'BTCUSDT', total: '0.05', holdMode: 'one_way_mode', posSide: 'short', markPrice: '99000' }, 0.001)), JSON.stringify({ contract: 'BTC_USDT', size: '-50', mode: 'single', leverage: '0', margin_mode: '', entry_price: '0', mark_price: '99000', liq_price: '0', unrealised_pnl: '0', realised_pnl: '0', value: '4950' })],
  ['map UTA order quantity, fill, reduce-only and timestamp', JSON.stringify(mapBitgetUtaOrder({ orderId: '123', symbol: 'BTCUSDT', qty: '0.012', cumExecQty: '0.002', side: 'sell', orderStatus: 'partially_filled', price: '99000', avgPrice: '99500', reduceOnly: 'YES', createdTime: '1730186725663', timeInForce: 'ioc' }, 0.001)), JSON.stringify({ id: '123', contract: 'BTC_USDT', size: '-12', left: '10', price: '99000', fill_price: '99500', status: 'open', finish_as: '', is_reduce_only: true, create_time: 1730186726, tif: 'ioc' })],
  ['map UTA hedge close long to the long side', mapBitgetUtaOrder({ symbol: 'BTCUSDT', qty: '0.01', side: 'sell', posSide: 'long', holdMode: 'hedge_mode', tradeSide: 'close', reduceOnly: 'YES' }, 0.001).size, '10'],
  ['map UTA hedge close short to the short side', mapBitgetUtaOrder({ symbol: 'BTCUSDT', qty: '0.01', side: 'buy', posSide: 'short', holdMode: 'hedge_mode', tradeSide: 'close', reduceOnly: 'YES' }, 0.001).size, '-10'],
  ['split UTA TP/SL while retaining shared cancellation id', JSON.stringify(mapBitgetStrategyTriggers({ orderId: '987', symbol: 'BTCUSDT', qty: '0.012', side: 'sell', posSide: 'long', status: 'pending', stopLoss: '99000', takeProfit: '110000', createdTime: '1730186725663' }, 0.001).map((trigger) => ({ id: trigger.id, cancel_id: trigger.cancel_id, price: trigger.trigger.price, rule: trigger.trigger.rule, auto_size: trigger.initial.auto_size }))), JSON.stringify([{ id: 'stop:987', cancel_id: '987', price: '99000', rule: 2, auto_size: 'close_long' }, { id: 'target:987', cancel_id: '987', price: '110000', rule: 1, auto_size: 'close_long' }])],
  ['infer UTA one-way short direction without posSide', mapBitgetStrategyTriggers({ orderId: '654', symbol: 'BTCUSDT', side: 'buy', stopLoss: '110000' }, 0.001)[0]?.initial.auto_size, 'close_short'],
];
let failures = 0;
for (const [name, got, want] of checks) {
  if (got === want) console.log('  ✓ ' + name);
  else { failures += 1; console.error(`  ✗ ${name}: got ${got}, want ${want}`); }
}
if (failures) process.exit(1);
console.log('✓ Bitget UTA order mapping checks passed');
