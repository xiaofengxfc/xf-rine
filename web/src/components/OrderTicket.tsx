import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, jsend, type Account, type ContractInfo } from '../lib/api.ts';
import { fmtMoney, fmtPrice, fmtUsd, fmtPct } from '../lib/format.ts';
import { protectionRows, wrongSide } from '../lib/protection.ts';
import { percentSizing } from '../lib/sizing.ts';
import { pnlFromCost } from '../lib/position.ts';

/** 仓位比例的几个档。做日内的人只在这几个数之间选，比让他填一个百分比快 */
const POS_STEPS = [25, 50, 75, 100];

interface Props {
  contract: ContractInfo | null;
  armed: boolean;
  token: string | null;
  account: Account | null;
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
  contract, armed, token, account, liveTrading, keysConfigured, env,
  posPct, onPosPctChange, onToast, onRefresh, onQueueProtect,
  limitStr, onLimitChange, stopStr, onStopChange, targetStr, onTargetChange,
  priceMode, onPriceModeChange, onResetPrices,
}: Props) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeStr, setSizeStr] = useState('');
  /** 用户自己改过张数之后，就不再让「按比例算」覆盖他的输入 */
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
  // Gate 有些合约把 order_size_min 报成 0（意思是没单独要求），
  // 但张数只能是正整数，照抄 0 会让「最小」按钮填个 0 进去，校验也拦不住。
  const sizeMin = Math.max(1, Math.ceil(contract?.sizeMin ?? 1));
  const levMax = Math.min(contract?.leverageMax ?? 20, 125);
  const sizeMax = Math.floor(contract?.sizeMax ?? 0);
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
    setSizeStr('');
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
    sizeMax,
  }), [avail, posPct, priceUsed, mult, lev, feeRate, sizeMin, sizeMax]);

  // 没自己改过张数，就让比例说了算（换价、换杠杆、换比例都跟着变）
  useEffect(() => {
    if (sizeTouched) return;
    setSizeStr(sizing.size > 0 ? String(sizing.size) : '');
  }, [sizing.size, sizeTouched]);

  const size = Math.round(Number(sizeStr) || 0);
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
    if (!priceUsed || lev <= 0) return 0;
    const move = 1 / lev;
    return side === 'long' ? priceUsed * (1 - move) : priceUsed * (1 + move);
  }, [priceUsed, lev, side]);

  // 拦下的第一条原因就写在按钮上，按顺序返回
  const blocked = (() => {
    if (!contract) return '没有选中合约';
    if (contract.tradable === false) return '模拟盘没有这个合约';
    if (!keysConfigured) return '未配置 API 密钥';
    if (!liveTrading) return '服务端 LIVE_TRADING=false，下单被禁用';
    if (!armed) return '先点右上角解锁交易';
    /**
     * 限价模式下限价必须是一个正数。
     *
     * 这条要排在张数前面：比例算张数时除的就是这个价，价空着张数会是 0 或 1，
     * 提示成「张数至少 1」会把人引到另一个框去改。
     */
    if (priceMode === 'limit' && !(priceUsed > 0)) return '限价还没填：先填一个价格再下单';
    if (size < sizeMin) return `张数至少 ${sizeMin}`;
    if (sizeMax > 0 && size > sizeMax) return `张数最多 ${sizeMax}`;
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
      return `可用 ${fmtUsd(avail)} USDT 按 ${lev}x 连 ${sizeMin} 张都不够（每张要 ${fmtUsd(mult * priceUsed / Math.max(lev, 1) + mult * priceUsed * feeRate)} USDT 保证金 + 手续费）。先降张数、提杠杆，或者换个小一点的合约。`;
    }
    if (sizing.clamped === 'min') {
      return `${posPct}% 的可用余额算不到 ${sizeMin} 张，已经提到最小下单量 ${sizeMin} 张。`;
    }
    if (sizing.clamped === 'max') {
      return `按 ${posPct}% 能开 ${Math.floor(sizing.raw)} 张，但合约上限是 ${sizeMax} 张，已经夹回去。`;
    }
    return '';
  })();

  async function submit() {
    if (!contract) return;
    // 点了没反应是最难查的一种：没解锁就直说，别静默返回
    if (!token) { onToast('err', '交易没解锁', '先点右上角的「解锁交易」'); return; }
    setBusy(true);
    try {
      try {
        await jsend('POST', '/api/leverage', { contract: contract.name, leverage: lev, mode: marginMode }, token);
      } catch (e) {
        /**
         * 密钥没有「合约交易」写权限时会先卡在设杠杆这一步。
         * 这时候再往下打一次下单，只会多一条一模一样的报错 ——
         * 以前页面连着弹「设置杠杆失败（继续下单）」和「下单失败」，
         * 两句都是交易所的英文原文，看不出到底该改什么。这里直接说清原因就收手。
         */
        if (e instanceof ApiError && e.label === 'KEY_NO_WRITE') {
          onToast('err', '这把密钥不能交易', (e as Error).message);
          return;
        }
        // 别的原因（比如这一边已经有仓，杠杆改不了）不阻断下单
        onToast('err', '设置杠杆失败（继续下单）', (e as Error).message);
      }

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
        `${r.order.status} · 名义 ${fmtUsd(r.checked.notional)} USDT`
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
            张数（{mult ? fmtUsd(mult, mult < 0.01 ? 4 : mult < 1 ? 2 : 0) : '—'} 币/张）
            <span className="dim"> · 按 {posPct}% 可用余额算得 {sizing.size} 张</span>
          </label>
          <input
            className="input"
            inputMode="numeric"
            placeholder={`最小 ${sizeMin}`}
            value={sizeStr}
            onChange={(e) => { setSizeStr(e.target.value.replace(/[^0-9]/g, '')); setSizeTouched(true); setPending(false); }}
          />
        </div>

        <div className="row4" style={{ marginBottom: 10 }}>
          {POS_STEPS.map((p) => (
            <button
              key={p}
              className="chip"
              style={posPct === p ? { background: 'var(--accent)', color: '#0b0e13', borderColor: 'var(--accent)' } : undefined}
              title={`用可用余额的 ${p}% 作保证金：` + fmtUsd(avail * (p / 100)) + ' USDT × ' + lev + 'x 杠杆'}
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
                {priceMode === 'limit' ? '限价' : '现价'} {fmtPrice(priceUsed, priceRound)} · {size} 张
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
            {marginMode === 'cross'
              ? '全仓按整个余额兜底，没有固定的强平价'
              : `≈ ${liqEstimate ? fmtPrice(liqEstimate, priceRound) : '—'}`}
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
              确认 {side === 'long' ? '买入开多' : '卖出开空'} <b>{size}</b> 张 {contract?.name}，
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
                按同样的杠杆最多做 {sizing.affordable} 张，或者把杠杆调高。
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
