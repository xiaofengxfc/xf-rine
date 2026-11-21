import { useEffect, type RefObject } from 'react';
import {
  LineStyle,
  type IPriceLine,
  type ISeriesApi,
} from 'lightweight-charts';
import type { Account, Bar, OpenOrder, Position, PriceOrder, Zone } from '../lib/api.ts';
import { chartZoneLineStyle, selectChartZones } from '../lib/chartLevelStyle.ts';
import { fmtPrice } from '../lib/format.ts';
import { positionLiquidationPrice } from '../lib/liquidation.ts';
import { pendingOrderLines } from '../lib/orderLines.ts';
import { bracketOf } from '../lib/protective.ts';
import type { CandleStyle } from '../lib/chartStyle.ts';

const HOLDING = '#ffcf4d';
const LIQ = '#ff7a45';
const PENDING = '#b58bff';

type ChartLineSeries = ISeriesApi<'Candlestick'> | ISeriesApi<'Bar'> | ISeriesApi<'Line'>;

interface SeriesRefs {
  price: RefObject<ISeriesApi<'Candlestick'> | null>;
  bar: RefObject<ISeriesApi<'Bar'> | null>;
  line: RefObject<ISeriesApi<'Line'> | null>;
  lines: RefObject<IPriceLine[]>;
  bars: RefObject<Bar[]>;
}

export interface ChartPriceLineInput {
  positions: Position[];
  orders: OpenOrder[];
  priceOrders: PriceOrder[];
  zones: Zone[];
  bars: Bar[];
  account: Account | null | undefined;
  markPrice: number;
  stale: boolean;
  priceRound: number;
}

interface Props extends Omit<ChartPriceLineInput, 'bars'> {
  refs: SeriesRefs;
  candleStyle: CandleStyle;
  drawMode: 'candle' | 'line';
  storageKey: string;
  narrow: boolean;
}

export interface ChartPriceLine {
  price: number;
  rank: number;
  color: string;
  width: 1 | 2;
  style: LineStyle;
  title: string;
  axisLabelVisible?: boolean;
}

function contentSignature({ positions, orders, priceOrders, zones, account, markPrice, stale, priceRound }: ChartPriceLineInput): string {
  return [
    positions.map((position) => [
      position.contract,
      position.direction,
      position.entryPrice,
      position.size,
      position.liqPrice,
      position.leverage,
      position.marginMode,
      positionLiquidationPrice(position, account, stale ? 0 : markPrice),
    ].join(',')).join(';'),
    pendingOrderLines(orders).map((order) => `${order.id}@${order.price}x${order.size}`).join(';'),
    priceOrders.map((order) => `${order.id}@${order.triggerPrice}:${order.triggerRule}:${order.direction}`).join(';'),
    // Engine results are floating point. Values that format to the same exchange tick need no redraw.
    zones.map((zone) => [
      zone.history ? 'h' : 'c',
      zone.zone_type,
      fmtPrice(zone.center, priceRound),
      zone.p_touch,
      zone.p_hold,
      zone.n_events,
      zone.tf_count,
    ].join(',')).join(';'),
  ].join('|');
}

export function buildChartPriceLines(data: ChartPriceLineInput): ChartPriceLine[] {
  const { positions, orders, priceOrders, zones, bars, account, markPrice, stale, priceRound } = data;
  const lastPrice = bars[bars.length - 1]?.close ?? 0;
  const lines: ChartPriceLine[] = [];

  for (const position of positions) {
    if (!(position.entryPrice && position.size)) continue;
    lines.push({
      price: position.entryPrice,
      rank: 1,
      color: HOLDING,
      width: 2,
      style: LineStyle.Solid,
      title: positions.length > 1
        ? (position.direction === 'long' ? '多单均价' : '空单均价')
        : '持仓均价',
    });
  }

  for (const position of positions) {
    const liquidationPrice = positionLiquidationPrice(position, account, stale ? 0 : markPrice);
    if (!(liquidationPrice > 0)) continue;
    const estimated = !(position.liqPrice > 0);
    lines.push({
      price: liquidationPrice,
      rank: 1.2,
      color: LIQ,
      width: 1,
      style: LineStyle.Dashed,
      title: (estimated ? '预估' : '')
        + (positions.length > 1
          ? (position.direction === 'long' ? '多单强平' : '空单强平')
          : '强平价')
        + (estimated ? ' ≈ ' + fmtPrice(liquidationPrice, priceRound) : ''),
    });
  }

  for (const position of positions) {
    const bracket = bracketOf(priceOrders, position.contract, position.direction);
    const multiplePositions = positions.length > 1;
    if (bracket.stop) {
      lines.push({
        price: bracket.stop.triggerPrice,
        rank: 1.05,
        color: 'rgba(255,95,109,0.85)',
        width: 2,
        style: LineStyle.Dashed,
        title: (multiplePositions
          ? (position.direction === 'long' ? '多单止损 ' : '空单止损 ')
          : '止损 ')
          + fmtPrice(bracket.stop.triggerPrice, priceRound),
      });
    }
    if (bracket.target) {
      lines.push({
        price: bracket.target.triggerPrice,
        rank: 1.06,
        color: 'rgba(46,211,160,0.85)',
        width: 2,
        style: LineStyle.Dashed,
        title: (multiplePositions
          ? (position.direction === 'long' ? '多单止盈 ' : '空单止盈 ')
          : '止盈 ')
          + fmtPrice(bracket.target.triggerPrice, priceRound),
      });
    }
  }

  for (const order of pendingOrderLines(orders)) {
    lines.push({
      price: order.price,
      rank: 1.5,
      color: PENDING,
      width: 2,
      style: LineStyle.Dashed,
      title: order.label,
    });
  }

  const nearbyZones = selectChartZones(zones, lastPrice);
  nearbyZones.forEach((zone, index) => {
    const appearance = chartZoneLineStyle({
      type: zone.zone_type,
      history: zone.history === true,
      priceLabel: fmtPrice(zone.center, priceRound),
      pTouch: zone.p_touch,
      pHold: zone.p_hold,
    });
    lines.push({
      price: zone.center,
      rank: 3 + index * 0.01,
      color: appearance.color,
      width: appearance.width,
      style: LineStyle.Solid,
      title: appearance.title,
      axisLabelVisible: appearance.axisLabelVisible,
    });
  });

  return lines.sort((left, right) => left.rank - right.rank);
}

export function useChartPriceLines(props: Props): void {
  const {
    refs,
    positions,
    orders,
    priceOrders,
    zones,
    account,
    markPrice,
    stale,
    priceRound,
    candleStyle,
    drawMode,
    storageKey,
    narrow,
  } = props;
  const data: ChartPriceLineInput = {
    positions,
    orders,
    priceOrders,
    zones,
    bars: refs.bars.current,
    account,
    markPrice,
    stale,
    priceRound,
  };
  const levelSignature = contentSignature(data);

  useEffect(() => {
    const owner = drawMode === 'line'
      ? refs.line.current
      : candleStyle === 'american' ? refs.bar.current : refs.price.current;
    if (!owner) return;

    const allSeries: ChartLineSeries[] = [];
    if (refs.price.current) allSeries.push(refs.price.current);
    if (refs.bar.current) allSeries.push(refs.bar.current);
    if (refs.line.current) allSeries.push(refs.line.current);
    for (const series of allSeries) {
      for (const line of refs.lines.current) series.removePriceLine(line);
    }
    refs.lines.current = [];

    for (const item of buildChartPriceLines(data)) {
      if (!Number.isFinite(item.price)) continue;
      try {
        refs.lines.current.push(owner.createPriceLine({
          price: item.price,
          color: item.color,
          lineWidth: item.width,
          lineStyle: item.style,
          axisLabelVisible: item.axisLabelVisible ?? true,
          title: item.title,
        }));
      } catch (error) {
        console.warn('[chart] 一条横线没画上', item.title, error);
      }
    }
    // The signature avoids redrawing unchanged price lines on each REST refresh.
    // storageKey and narrow also rebuild axis labels for a new market or viewport width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelSignature, priceRound, candleStyle, drawMode, storageKey, narrow]);
}
