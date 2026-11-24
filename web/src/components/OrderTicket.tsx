import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsend, type Account, type ContractInfo } from '../lib/api.ts';
import { fmtMoney, fmtPrice, fmtUsd, fmtPct } from '../lib/format.ts';
import { crossCollateralCoversDropToZero, estimateLiquidationPrice } from '../lib/liquidation.ts';
import { protectionRows, wrongSide } from '../lib/protection.ts';
import { floorToSizeStep, percentSizing } from '../lib/sizing.ts';
import { coinDecimalsOf, coinStepOf, coinsToContracts, coinsToInput, contractsToCoins, fmtCoins } from '../lib/units.ts';
import { pnlFromCost } from '../lib/position.ts';

/** 仓位比例的几个档。做日内的人只在这几个数之间选，比让他填一个百分比快 */
const POS_STEPS = [25, 50, 75, 100];

interface Props {
  contract: ContractInfo | null;
  armed: boolean;
  token: string | null;
  account: Account | null;
  dailyRealisedPnl: number | null;
  dailyPnlError?: string | null;
  currentPnl: number | null;
  accountError?: string | null;
  privateError?: string | null;
  liveTrading: boolean;
  keysConfigured: boolean;
  env: 'testnet' | 'live';
  /** 用可用余额的百分之几开仓 */
  posPct: number;
  onPosPctChange: (v: number) => void;
  /**
   * 限价 / 止损价 / 止盈价三个框提在页面这一层。
   *
   * 为什么不让面板自己存：图上右键取价要把价格填进这几个框，
   * 面板自己拿着状态，图表就够不着它们 —— 只能靠「传一个值进去再清空」这种办法，
   * 而那个办法在同一个价连点两次时就不灵了。提上来之后，谁都能写，写进去就是所见即所得。
   */
  limitStr: string;
  onLimitChange: (v: string) => void;
  stopStr: string;
  onStopChange: (v: string) => void;
  targetStr: string;
  onTargetChange: (v: string) => void;
  /** 价格模式也提上去：右键「作为限价」时要把面板从「市价」切回「限价」 */
  priceMode: 'market' | 'limit';
  onPriceModeChange: (m: 'market' | 'limit') => void;
  /** 换合约时面板要自己清空，清空动作回到页面上做 */
  onResetPrices: () => void;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
  onRefresh: () => void;
  /**
   * 限价单还没成交、保护单挂不上时，把要挂的价交给页面记着。
   * 带上委托号：回踩单可能挂上几个小时，页面要靠它判断「入场单还在不在」，
   * 不能再用固定时长判过期（半小时就丢，成交之后保护不补挂，等于裸仓开进去）。
   */
  onQueueProtect: (p: {
    contract: string; direction: 'long' | 'short'; stop: number; target: number; orderId: string;
  }) => void;
}

export default function OrderTicket({
  contract, armed, token, account, dailyRealisedPnl, dailyPnlError = null, currentPnl,
  accountError = null, privateError = null, liveTrading, keysConfigured, env,
  posPct, onPosPctChange, onToast, onRefresh, onQueueProtect,
  limitStr, onLimitChange, stopStr, onStopChange, targetStr, onTargetChange,
  priceMode, onPriceModeChange, onResetPrices,
}: Props) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  /** 框里存的是币数量（数字串），张数由它算出来 —— 交易所那边认的本来就是币 */
  const [qtyStr, setQtyStr] = useState('');
  /** 用户自己改过数量之后，就不再让「按比例算」覆盖他的输入 */
  const [sizeTouched, setSizeTouched] = useState(false);
  const setStopStr = onStopChange;
  const setTargetStr = onTargetChange;
  const setPriceMode = onPriceModeChange;
  const setLimitStr = onLimitChange;
  const [leverage, setLeverage] = useState(10);
  /**
   * 逐仓还是全仓。默认逐仓。
   *
   * 交易所账户默认是全仓：那样一个仓亏穿了会继续吃整个余额。逐仓只赔这一笔的保证金，
   * 止损才有意义。所以默认逐仓，要全仓得自己点一下 —— 反过来（默认全仓）等于默认承担最大的风险。
   */
  const [marginMode, setMarginMode] = useState<'isolated' | 'cross'>('isolated');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 限价框自动填过一次就不再管，用户自己清空是用户的事 */
  const autoLimitRef = useRef(false);

  const mult = contract?.multiplier ?? 0;
  const last = contract?.price ?? 0;
  const mark = contract?.markPrice ?? 0;
  const priceRound = contract?.priceRound ?? 0.1;
  const baseCurrency = contract?.name.split('_')[0] || '币';
  // 最小量和增量按交易所原值展示，不能把合法的小数张数向上取成整数。
  const sizeStep = contract?.sizeStep && contract.sizeStep > 0 ? contract.sizeStep : 1;
  const sizeMin = contract?.sizeMin && contract.sizeMin > 0 ? contract.sizeMin : sizeStep;
  const levMax = Math.min(contract?.leverageMax ?? 20, 125);
  const sizeMax = contract?.sizeMax && contract.sizeMax > 0
    ? floorToSizeStep(contract.sizeMax, sizeStep)
    : 0;
  /** 币那一侧的下单步进和位数：交易所给的是「张」的步进，乘上每张币数就是币的 */
  const coinStep = coinStepOf(mult, sizeStep);
  const coinDecimals = coinDecimalsOf(mult, sizeStep);
  /**
   * N 张折成多少基础币。
   *
   * 输入框那头按币算，这一头只负责把张数说成人看得懂的币数。换算和格式化
   * 全走 units.ts —— 这里再写一份除法，两处就会慢慢长成不同的口径。
   */
  const coinsOf = useCallback((contracts: number): string =>
    contracts > 0 && mult > 0 ? fmtCoins(contractsToCoins(contracts, mult), coinDecimals) : '—',
  [mult, coinDecimals]);
  // 杠杆上限跟着合约走。切到上限更低的合约时，原来的 50x 必须夹回去：
  // 不夹的话摘要会按交易所根本不接受的杠杆算保证金，设置杠杆那一步也会静默失败，
  // 最后真正下单用的还是账户上原来的杠杆，和确认条上写的不是一回事。
  const lev = Math.min(Math.max(1, leverage), levMax);
  useEffect(() => {
    setLeverage((v) => Math.min(Math.max(1, v), levMax));
  }, [levMax]);

  /** 吸附到最小变动单位 */
  const snapPrice = (p: number) => (priceRound > 0 ? Number((Math.round(p / priceRound) * priceRound).toFixed(10)) : p);

  useEffect(() => {
    setQtyStr('');
    setSizeTouched(false);
    setPending(false);
    // 三个价都清掉：换币种后留着上一个币的价格，点下去会被「价格偏离现价」拒掉
    onResetPrices();
    autoLimitRef.current = false;
    // onResetPrices 是页面给的稳定回调，不放进依赖会让「换合约」这件事漏掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract?.name]);

  // 限价框空着的时候，提交上去的其实是市价单（price 0），摘要里全是「—」，
  // 按比例算张数也会按一个不会真正发出去的价算。所以第一次切到限价就把现价填进去。
  useEffect(() => {
    if (autoLimitRef.current || priceMode !== 'limit' || !(last > 0)) return;
    autoLimitRef.current = true;
    setLimitStr(String(snapPrice(last)));
  }, [priceMode, last, priceRound]);

  const priceUsed = priceMode === 'limit' ? Number(limitStr) || 0 : last;
  const avail = account?.available ?? 0;
  const crossCollateral = account && account.total > 0 ? account.total : avail;
  // 交易所按「保证金 + 手续费 ≤ 可用」放行。满仓如果只算保证金，
  // 差的正好是那几块钱手续费，点满仓必然被拒。
  const feeRate = Math.max(contract?.takerFee ?? 0, 0);

  /**
   * 按比例算张数。分母里带上手续费，所以点 100% 时算出来的张数刚好卡在
   * 「保证金 + 手续费 = 可用余额」上，不会因为差几毛钱被交易所拒掉。
   */
  const sizing = useMemo(() => percentSizing({
    available: avail,
    pct: posPct,
    price: priceUsed,
    multiplier: mult,
    leverage: lev,
    feeRate,
    sizeMin,
    sizeStep,
    sizeMax,
  }), [avail, posPct, priceUsed, mult, lev, feeRate, sizeMin, sizeStep, sizeMax]);

  /**
   * 某一档百分比能开多少张。
   *
   * 四个 chip 上都要把这个数写出来：余额不够时按比例算出来是 0 张，
   * 输入框里没变化，点起来就像按钮坏了。有了这行字，一眼能看出是「余额不够」
   * 而不是「点了没反应」。
   */
  const pctPreview = useCallback((p: number) => percentSizing({
    available: avail,
    pct: p,
    price: priceUsed,
    multiplier: mult,
    leverage: lev,
    feeRate,
    sizeMin,
    sizeStep,
    sizeMax,
  }), [avail, priceUsed, mult, lev, feeRate, sizeMin, sizeStep, sizeMax]);

  const chipTitle = useCallback((p: number): string => {
    const r = pctPreview(p);
    const margin = fmtUsd(avail * (p / 100));
    if (avail <= 0) return '可用余额是 0，先入金或者把别的仓平掉';
    if (r.size <= 0) {
      return `用 ${p}% 可用余额（${margin} USDT × ${lev}x）低于最低下单量 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）`;
    }
    return `用 ${p}% 可用余额（${margin} USDT × ${lev}x）可开 ${coinsOf(r.size)} ${baseCurrency}（${r.size} 张），约 ${fmtUsd(r.usedMargin)} USDT 保证金`;
  }, [pctPreview, avail, lev, sizeMin, baseCurrency, coinsOf]);

  // 没自己改过数量，就让比例说了算（换价、换杠杆、换比例都跟着变）
  useEffect(() => {
    if (sizeTouched) return;
    setQtyStr(coinsToInput(contractsToCoins(sizing.size, mult), coinDecimals));
  }, [sizing.size, sizeTouched, mult, coinDecimals]);

  /** 框里那个币数，和它实际能下出去多少张。中间差的是「按步进向下取整」那一下 */
  const qtyCoins = Number(qtyStr) || 0;
  const size = coinsToContracts(qtyCoins, mult, sizeStep);
  const actualCoins = contractsToCoins(size, mult);
  const notional = size * mult * priceUsed;
  const margin = lev > 0 ? notional / lev : 0;
  const need = margin + notional * feeRate;
  const marginShort = need > avail ? need - avail : 0;

  const stopNum = Number(stopStr) || 0;
  const targetNum = Number(targetStr) || 0;
  const wantProtect = stopNum > 0 || targetNum > 0;

  /**
   * 止损 / 止盈价对应的盈亏，多空各算一遍。
   *
   * 为什么两个方向都写：同一个止损价，做多是亏、做空就是赚。只算当前选的那一边，
   * 一换方向就看不到对照 —— 而「这个价对空头是好是坏」正是下单前最该确认的事。
   *
   * 入场价跟着这一单走：限价单用填的限价，市价单用现价（priceUsed 本来就是这口径）。
   * 盈亏公式全站只有 pnlFromCost 一个（和持仓卡、交易所同口径），这里不另写一套。
   */
  const pnlBase = lev > 0 ? (priceUsed * size * mult) / lev : 0;
  const pnlCell = (dir: 'long' | 'short', price: number) => {
    const pnl = pnlFromCost(dir, priceUsed, size, mult, price);
    return { pnl, roe: pnlBase > 0 ? (pnl / pnlBase) * 100 : null };
  };
  const pnlRows = size > 0 && mult > 0 && priceUsed > 0
    ? [
        ...(stopNum > 0 ? [{ key: 'stop', label: '止损', price: stopNum }] : []),
        ...(targetNum > 0 ? [{ key: 'target', label: '止盈', price: targetNum }] : []),
      ].map((r) => ({ ...r, long: pnlCell('long', r.price), short: pnlCell('short', r.price) }))
    : [];
  /** 开平各一次的手续费，按这一单的张数估。盈亏里不扣它，单独写一行说清楚 */
  const feeRound = priceUsed * size * mult * feeRate * 2;

  // 触发单看的是最新成交价，标记价常常比它更靠里，所以 wrongSide 内部两边取更严格的那个
  // 触发单是成交之后才挂的，那一刻现价≈成交价。所以拿「这一单会成交在哪个价」判，
  // 而不是拿此刻的现价：回踩挂单时现价离入场还远，用现价判会把合法的止盈误判成跑过头。
  // 标记价那道保险只在按市价进的时候才需要 —— 那时成交价就是现价。
  const fillAtMarket = !(priceUsed > 0) || Math.abs(priceUsed - last) / (last || 1) < 0.0005;
  const wrong = wrongSide(side, stopNum, targetNum, priceUsed, fillAtMarket ? mark : 0);

  const liqEstimate = useMemo(() => {
    return estimateLiquidationPrice({
      side,
      entryPrice: priceUsed,
      size,
      multiplier: mult,
      leverage: lev,
      marginMode,
      collateral: crossCollateral,
    });
  }, [priceUsed, size, mult, lev, marginMode, crossCollateral, side]);
  const crossSurvivesToZero = marginMode === 'cross' && crossCollateralCoversDropToZero({
    side,
    entryPrice: priceUsed,
    size,
    multiplier: mult,
    leverage: lev,
    marginMode,
    collateral: crossCollateral,
  });

  // 拦下的第一条原因就写在按钮上，按顺序返回
  const blocked = (() => {
    if (!contract) return '没有选中合约';
    if (contract.tradable === false) return '模拟盘没有这个合约';
    if (!keysConfigured) return '未配置 API 密钥';
    if (!account) return accountError ? '账户余额读取失败' : '正在读取账户余额';
    if (!(avail > 0)) return '可用余额为 0，暂不能下单';
    if (/KEY_POSITION_PERMISSION|40014/.test(privateError ?? '')) return 'API Key 缺少合约仓位读取权限，暂不能安全下单';
    if (/KEY_NO_WRITE/.test(privateError ?? '')) return 'API Key 缺少合约交易写入权限，无法下单';
    if (!liveTrading) return '服务端 LIVE_TRADING=false，下单被禁用';
    if (!armed) return '先点右上角解锁交易';
    /**
     * 限价模式下限价必须是一个正数。
     *
     * 这条要排在数量前面：比例算张数时除的就是这个价，价空着数量会是 0 或 1，
     * 提示成「至少 1 张」会把人引到另一个框去改。
     */
    if (priceMode === 'limit' && !(priceUsed > 0)) return '限价还没填：先填一个价格再下单';
    // 乘数读不到就没法把币折成张，这时候下单只能是猜
    if (!(mult > 0)) return '没读到这个合约的乘数，换算不了数量';
    if (!(qtyCoins > 0)) return '数量不合法';
    /**
     * 折完不够一张。
     *
     * 框里写着的币数是合法的数，只是凑不满一手 —— 只说「不合法」人能对着一个
     * 看着正常的数字琢磨半天。这里直接说清楚最低是多少币、折几张。
     */
    if (size <= 0) return `低于最低下单量 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）`;
    if (size < sizeMin) return `至少 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）`;
    if (sizeMax > 0 && size > sizeMax) return `最多 ${coinsOf(sizeMax)} ${baseCurrency}（${sizeMax} 张）`;
    if (stopNum > 0 && priceUsed > 0 && wrong.stop) {
      return side === 'long' ? '止损要在现价下方' : '止损要在现价上方';
    }
    if (targetNum > 0 && priceUsed > 0 && wrong.target) {
      return side === 'long' ? '止盈要在现价上方' : '止盈要在现价下方';
    }
    return '';
  })();

  // 摘要下方那一小截：只列这一单真会挂上去的保护
  const protectRows = protectionRows(side, stopNum, targetNum, priceUsed, fillAtMarket ? mark : 0);

  /** 比例算出来的张数被夹住时，把账写清楚：想要多少、能下多少、为什么 */
  const sizingNote = (() => {
    if (sizing.clamped === 'afford' && priceUsed > 0) {
      return `可用 ${fmtUsd(avail)} USDT 按 ${lev}x 连最低下单量 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）都不够（每张要 ${fmtUsd(mult * priceUsed / Math.max(lev, 1) + mult * priceUsed * feeRate)} USDT 保证金 + 手续费）。先降数量、提杠杆，或者换个小一点的合约。`;
    }
    if (sizing.clamped === 'min') {
      return `${posPct}% 的可用余额预算低于最低下单量 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）；不会自动超出所选比例。`;
    }
    if (sizing.clamped === 'max') {
      const fits = floorToSizeStep(sizing.raw, sizeStep);
      return `按 ${posPct}% 能开 ${coinsOf(fits)} ${baseCurrency}（${fits} 张），但合约上限是 ${coinsOf(sizeMax)} ${baseCurrency}（${sizeMax} 张），已经夹回去。`;
    }
    return '';
  })();

  async function submit() {
    if (!contract) return;
    // 点了没反应是最难查的一种：没解锁就直说，别静默返回
    if (!token) { onToast('err', '交易没解锁', '先点右上角的「解锁交易」'); return; }
    setBusy(true);
    try {
      type Attach =
        | { status: 'attached'; created: { kind: string }[] }
        /** 止损止盈只挂上了一边，另一边被交易所拒了 */
        | { status: 'partial'; created: { kind: string }[]; errors: string[] }
        | { status: 'pending' }
        | { status: 'failed'; error: string }
        | null;
      const r = await jsend<{ ok: boolean; order: { id: string; status: string; fillPrice: number }; bracket: Attach; margin: { applied: boolean; mode: string; why?: string } | null; checked: { notional: number } }>(
        'POST', '/api/order',
        {
          contract: contract.name,
          size,
          side,
          price: priceMode === 'limit' ? priceUsed : 0,
          tif: priceMode === 'market' ? 'ioc' : 'gtc',
          stop: wantProtect ? stopNum : 0,
          target: wantProtect ? targetNum : 0,
          // 服务端会照着这个把保证金模式先设好；设不成就不发单
          marginMode,
          leverage: lev,
        },
        token,
      );
      const b = r.bracket;
      onToast(
        'ok',
        `下单成功 #${r.order.id}`,
        `${r.order.status} · ${fmtCoins(actualCoins, coinDecimals)} ${baseCurrency}（${size} 张） · 名义 ${fmtUsd(r.checked.notional)} USDT`
        + `${r.order.fillPrice ? ` · 成交价 ${r.order.fillPrice}` : ''}`
        + `${b?.status === 'attached' ? ' · 保护单已挂' : b?.status === 'partial' ? ' · 保护只挂上了一边' : b?.status === 'pending' ? ' · 成交后自动补挂保护' : ''}`,
      );
      if (r.margin && !r.margin.applied) onToast('err', '保证金模式没动', r.margin.why ?? '这一边已经有持仓，模式沿用交易所现状');
      if (b?.status === 'failed') onToast('err', '保护单没挂上', b.error);
      // 一边挂上、一边没挂上是最危险的情况：看着有保护，实际少了一半
      if (b?.status === 'partial') onToast('err', '保护只挂上了一边', b.errors.join(' · '));
      if (b?.status === 'pending') {
        onQueueProtect({ contract: contract.name, direction: side, stop: stopNum, target: targetNum, orderId: r.order.id });
      }
      setPending(false);
      setSizeTouched(false);
      onRefresh();
    } catch (e) {
      onToast('err', '下单失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        {/* 可选链只护到 .name：contract 为 null 时这里会变成 undefined.replace()，整页被 ErrorBoundary 吃掉。
            本地数据模式下 info 就是 null（没有合约参数），这条路径是能走到的 */}
        <h3>下单 · {(contract?.name ?? '').replace('_USDT', '') || '—'}</h3>
        <span className="dim" style={{ fontSize: 10 }}>1 张 = {mult || '—'} 币</span>
      </div>
      <div className="card-body">
        <div className="ticket-account" aria-live="polite">
          <div><span>总权益</span><b className="num">{account ? `${fmtUsd(account.total)} ${account.currency || 'USDT'}` : '—'}</b></div>
          <div><span>可用余额</span><b className="num">{account ? `${fmtUsd(account.available)} ${account.currency || 'USDT'}` : '—'}</b></div>
          <div title={dailyPnlError ?? '今日范围，盈利与亏损合并累计，不含手续费和资金费'}>
            <span>已实现盈亏</span>
            <b className={`num ${dailyRealisedPnl === null ? '' : dailyRealisedPnl >= 0 ? 'up' : 'down'}`}>
              {dailyPnlError ? '读取失败' : dailyRealisedPnl === null ? '—' : `${fmtMoney(dailyRealisedPnl)} ${account?.currency || 'USDT'}`}
            </b>
          </div>
          <div className="ticket-account-current" title="当前所有仍持仓仓位的浮动盈亏总和">
            <span>当前浮动盈亏</span>
            <b className={`num ${currentPnl === null ? '' : currentPnl >= 0 ? 'up' : 'down'}`}>
              {currentPnl === null ? '—' : `${fmtMoney(currentPnl)} ${account?.currency || 'USDT'}`}
            </b>
          </div>
          <span className={`ticket-account-status ${accountError ? 'down' : account ? 'up' : 'dim'}`} title={accountError ?? undefined}>
            {accountError ? '读取失败' : account ? '实时' : '读取中'}
          </span>
        </div>
        {privateError && <div className="warn-box ticket-private-error" title={privateError}>部分交易数据读取失败：{privateError}</div>}
        {contract?.tradable === false && (
          <div className="warn-box">
            模拟盘没有这个合约，下单会被交易所拒绝。测试网只上架了几十个合约 —— 换一个主流币，或者到设置页切到实盘。
          </div>
        )}

        <div className="side-toggle">
          <button className={`long ${side === 'long' ? 'on' : ''}`} onClick={() => { setSide('long'); setPending(false); }}>买入开多</button>
          <button className={`short ${side === 'short' ? 'on' : ''}`} onClick={() => { setSide('short'); setPending(false); }}>卖出开空</button>
        </div>

        <div className="field">
          <label>
            数量（{baseCurrency}）
            <span className="dim"> · 按 {posPct}% 可用余额算得 {sizing.size > 0 ? `${coinsOf(sizing.size)} ${baseCurrency}` : '—'}</span>
          </label>
          <div className="size-wrap">
            <input
              className="input"
              inputMode="decimal"
              aria-label="下单数量"
              placeholder={`最小 ${coinsOf(sizeMin)}`}
              // 桌面端悬停时浏览器也会弹一句，和下面那张卡片说的是同一件事
              title={`最低下单量 ${coinsOf(sizeMin)} ${baseCurrency}（${sizeMin} 张）`}
              value={qtyStr}
              onChange={(e) => {
                const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                const [whole = '', ...fraction] = cleaned.split('.');
                setQtyStr(fraction.length > 0 ? `${whole}.${fraction.join('')}` : whole);
                setSizeTouched(true);
                setPending(false);
              }}
              /**
               * 失焦时把框里的数字吸附到真正会提交出去的那个币数。
               *
               * 打字的时候不吸附：边打边改，人连「0.0123」都打不完。但离开输入框之后，
               * 框里留着的必须就是会被提交的那个数 —— 差的这一下在这里补。
               * 不够一张时（size 为 0）不动它：一失焦就清空，人还得重打一遍。
               */
              onBlur={() => {
                if (size > 0) setQtyStr(coinsToInput(actualCoins, coinDecimals));
              }}
            />
            {/**
              * 最低下单量。
              *
              * 以前只在 placeholder 里写了个「最小 N」，一输入就看不见了 —— 想知道
              * 到底最少能下多少，只能把字删光或者去翻别的地方。
              * 现在悬停（桌面）和聚焦（手机点进输入框）都把它浮在输入框**上方**：
              * 手机键盘弹起来只占下半屏，写在上面的提示不会被挡住。
              */}
            <div className="size-tip">
              最低下单量 <b>{coinsOf(sizeMin)} {baseCurrency}</b>（{sizeMin} 张）
              {priceUsed > 0 && mult > 0 && (
                <>
                  {' · '}名义 {fmtUsd(sizeMin * mult * priceUsed)} USDT
                  {' · '}{lev}x 要 {fmtUsd((sizeMin * mult * priceUsed) / Math.max(lev, 1))} USDT 保证金
                </>
              )}
            </div>
          </div>
          {/**
           * 常显的一行。
           *
           * 浮层只在悬停/聚焦时出来，手机上一松手就没了 —— 「最低多少」这件事
           * 不能只存在一瞬间。这一行一直在输入框下面，写的是这个合约交易所
           * 真正给的最低成交数量，以及它折成多少基础币。
           */}
          <div className="size-min-line">
            最低下单量 <b>{coinsOf(sizeMin)} {baseCurrency}</b>（{sizeMin} 张{mult > 0 ? ` · 步进 ${fmtCoins(coinStep, coinDecimals)} ${baseCurrency}` : ''}）
            {priceUsed > 0 && mult > 0 && <>（名义 {fmtUsd(sizeMin * mult * priceUsed)} USDT）</>}
            {sizeMax > 0 && <span className="dim"> · 最多 {coinsOf(sizeMax)} {baseCurrency}（{sizeMax} 张）</span>}
          </div>
          {/**
           * 这一单实际会下出去多少。
           *
           * 框里填的是币数，交易所能吃的是「张 × 每张币数」的整数倍，两个数常常差一点点。
           * 差的这点不藏起来：这里把真正提交的张数和它对应的币数并排写出来，
           * 失焦时也把人填的数吸附到这一行上 —— 免得「看到的」和「下出去的」不是一回事。
           */}
          {size > 0 && (
            <div className="size-actual">
              实际下单 <b>{size} 张</b> = {fmtCoins(actualCoins, coinDecimals)} {baseCurrency}
            </div>
          )}
        </div>

        <div className="row4" style={{ marginBottom: 10 }}>
          {POS_STEPS.map((p) => (
            <button
              key={p}
              className="chip"
              style={posPct === p ? { background: 'var(--accent)', color: '#0b0e13', borderColor: 'var(--accent)' } : undefined}
              /**
               * 悬停时把这一档能开多少写出来。
               *
               * 以前点了只有输入框里的数字变，而余额不够时那个数字是 0 ——
               * 看着就像「点了没反应」。现在每一档都在悬停时把它算出来的币数写清楚，
               * 算不出一张的那几档直接置灰，省得人反复点。
               */
              title={chipTitle(p)}
              disabled={avail <= 0}
              onClick={() => { onPosPctChange(p); setSizeTouched(false); setPending(false); }}
            >
              {p}%
            </button>
          ))}
        </div>

        <div className="field" style={{ marginBottom: 9 }}>
          <label>杠杆 {lev}x</label>
          <input
            className="input sm"
            type="range"
            min={1}
            max={levMax}
            value={lev}
            onChange={(e) => setLeverage(Number(e.target.value))}
            style={{ padding: 0, accentColor: 'var(--accent)' }}
          />
        </div>

        <div className="seg" style={{ marginBottom: 6, width: '100%' }}>
          <button
            className={marginMode === 'isolated' ? 'on' : ''}
            style={{ flex: 1 }}
            title="只赔这一笔的保证金，亏到强平价就结束"
            onClick={() => { setMarginMode('isolated'); setPending(false); }}
          >逐仓</button>
          <button
            className={marginMode === 'cross' ? 'on' : ''}
            style={{ flex: 1 }}
            title="用整个可用余额兜底：亏穿了会继续扣账户里的钱"
            onClick={() => { setMarginMode('cross'); setPending(false); }}
          >全仓</button>
        </div>
        {marginMode === 'cross' && (
          <div className="edit-note" style={{ marginBottom: 8, color: 'var(--warn)' }}>
            全仓：这个仓亏穿了会继续吃账户里剩下的钱，止损护不住的部分由整个余额承担。
          </div>
        )}

        <div className="seg" style={{ marginBottom: 9, width: '100%' }}>
          <button className={priceMode === 'limit' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setPriceMode('limit')}>限价</button>
          <button className={priceMode === 'market' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setPriceMode('market')}>市价</button>
        </div>

        {priceMode === 'limit' && (
          <div className="field">
            <label>限价（最小变动 {priceRound}）</label>
            <input
              className="input"
              inputMode="decimal"
              placeholder={String(last)}
              value={limitStr}
              onChange={(e) => { setLimitStr(e.target.value.replace(/[^0-9.]/g, '')); setPending(false); }}
            />
          </div>
        )}

        <div className="row2" style={{ marginBottom: 6 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>止损价</label>
            <input
              className="input sm"
              inputMode="decimal"
              placeholder="留空就不挂"
              value={stopStr}
              onChange={(e) => { setStopStr(e.target.value.replace(/[^0-9.]/g, '')); setPending(false); }}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>止盈价</label>
            <input
              className="input sm"
              inputMode="decimal"
              placeholder="留空就不挂"
              value={targetStr}
              onChange={(e) => { setTargetStr(e.target.value.replace(/[^0-9.]/g, '')); setPending(false); }}
            />
          </div>
        </div>
        <div className="edit-note" style={{ marginBottom: 8 }}>
          两个价自己填，留空的那一边就不挂。成交之后才挂得上 —— 限价单还没成交时先记着，成交后页面自动补挂。
        </div>
        {!wantProtect && (
          <div className="edit-note" style={{ marginBottom: 8, color: 'var(--warn)' }}>
            两个价都空着，这一单不带保护。跳空的时候穿仓价就是强平价。
          </div>
        )}

        {pnlRows.length > 0 && (
          <div className="pnl-at">
            <div className="pnl-at-head">
              <span>
                {priceMode === 'limit' ? '限价' : '现价'} {fmtPrice(priceUsed, priceRound)} · {fmtCoins(actualCoins, coinDecimals)} {baseCurrency}（{size} 张）
              </span>
              <span className="dim">{lev}x</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th />
                  <th className={side === 'long' ? 'on' : ''}>做多</th>
                  <th className={side === 'short' ? 'on' : ''}>做空</th>
                </tr>
              </thead>
              <tbody>
                {pnlRows.map((r) => (
                  <tr key={r.key}>
                    <th>
                      {r.label} <span className="mono">{fmtPrice(r.price, priceRound)}</span>
                    </th>
                    {(['long', 'short'] as const).map((d) => {
                      const cell = d === 'long' ? r.long : r.short;
                      return (
                        <td key={d} className={(cell.pnl >= 0 ? 'up' : 'down') + (side === d ? ' on' : '')}>
                          {cell.pnl >= 0 ? '+' : ''}{fmtMoney(cell.pnl)}
                          {cell.roe !== null && (
                            <span className="dim"> {fmtPct(cell.roe, Math.abs(cell.roe) >= 100 ? 0 : 1)}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pnl-at-note">
              到价平掉这一笔的盈亏（{side === 'long' ? '当前做多' : '当前做空'}）
              · 不含手续费（开平各一次约 {fmtUsd(feeRound)} USDT）
            </div>
          </div>
        )}

        <dl className="summary">
          <dt>现价</dt><dd>{fmtPrice(last, priceRound)}</dd>
          <dt>数量</dt><dd>{size > 0 ? `${fmtCoins(actualCoins, coinDecimals)} ${baseCurrency}（${size} 张）` : '—'}</dd>
          <dt>名义价值</dt><dd className={notional > 0 ? '' : 'dim'}>{notional > 0 ? fmtUsd(notional) : '—'} USDT</dd>
          <dt>占用保证金</dt><dd className={marginShort > 0 ? 'down' : ''}>{margin > 0 ? fmtUsd(margin) : '—'} USDT</dd>
          <dt>手续费</dt><dd className="dim">{notional > 0 ? fmtUsd(notional * feeRate) : '—'} USDT</dd>
          <dt>可用</dt><dd>{fmtUsd(avail)} USDT</dd>
          {marginShort > 0 && (
            <><dt>保证金差</dt><dd className="down">{fmtUsd(marginShort)} USDT</dd></>
          )}
          <dt>保证金模式</dt>
          <dd>{marginMode === 'isolated' ? `逐仓 ${lev}x` : `全仓 ${lev}x`}</dd>
          <dt>预估强平价</dt>
          <dd className="dim">
            {liqEstimate > 0
              ? `≈ ${fmtPrice(liqEstimate, priceRound)}`
              : crossSurvivesToZero
                ? '无正强平价'
                : '—'}
          </dd>
          {protectRows.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.price > 0 ? (wrong.stop && row.label.startsWith('止损') ? 'down' : wrong.target && row.label.startsWith('止盈') ? 'down' : '') : 'dim'}>
                {row.price > 0 ? (
                  <>
                    {fmtPrice(row.price, priceRound)}
                    {row.pct !== null && (
                      <> <span className="dim">({fmtPct(row.pct, Math.abs(row.pct) < 0.01 ? 3 : 2)})</span></>
                    )}
                  </>
                ) : row.note}
              </dd>
            </Fragment>
          ))}
        </dl>

        {sizingNote && (
          <div className="warn-box" style={{ marginTop: 2 }}>{sizingNote}</div>
        )}

        {!pending ? (
          <button
            className={`btn ${side}`}
            disabled={Boolean(blocked) || busy}
            title={blocked || undefined}
            onClick={() => setPending(true)}
          >
            {blocked || (side === 'long' ? '买入开多' : '卖出开空')}
          </button>
        ) : (
          <div className="confirm">
            <p>
              确认 {side === 'long' ? '买入开多' : '卖出开空'} <b>{fmtCoins(actualCoins, coinDecimals)}</b> {baseCurrency}（{size} 张） {contract?.name}，
              {priceMode === 'limit' ? `限价 ${priceUsed}` : '市价'}，
              名义 <b>{fmtUsd(notional)}</b> USDT，{lev}x 杠杆，占用保证金 {fmtUsd(margin)} USDT。
              {env === 'testnet' ? '模拟盘，扣的是测试网假钱。' : '这是真实资金。'}
            </p>
            {wantProtect && (
              <p className="dim" style={{ fontSize: 11 }}>
                成交后挂保护：
                {stopNum > 0 ? `止损 ${fmtPrice(stopNum, priceRound)}` : ''}
                {stopNum > 0 && targetNum > 0 ? ' / ' : ''}
                {targetNum > 0 ? `止盈 ${fmtPrice(targetNum, priceRound)}` : ''}
              </p>
            )}
            {marginShort > 0 && (
              <p className="warn">
                保证金不够：连手续费要 {fmtUsd(need)} USDT，可用只有 {fmtUsd(avail)} USDT，差 {fmtUsd(marginShort)} USDT。
                按同样的杠杆最多做 {coinsOf(sizing.affordable)} {baseCurrency}（{sizing.affordable} 张），或者把杠杆调高。
              </p>
            )}
            <div className="acts">
              <button className="btn ghost" onClick={() => setPending(false)} disabled={busy}>取消</button>
              <button className={`btn ${side}`} onClick={submit} disabled={busy || Boolean(blocked)} title={blocked || undefined}>
                {busy ? '下单中…' : blocked || (env === 'testnet' ? '确认模拟下单' : '确认下单')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
