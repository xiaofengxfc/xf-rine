import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, jsend, type Account, type ContractInfo } from '../lib/api.ts';
import { fmtPrice, fmtUsd, fmtPct } from '../lib/format.ts';
import { protectionRows, wrongSide } from '../lib/protection.ts';
import { percentSizing } from '../lib/sizing.ts';

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
}: Props) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeStr, setSizeStr] = useState('');
  /** 用户自己改过张数之后，就不再让「按比例算」覆盖他的输入 */
  const [sizeTouched, setSizeTouched] = useState(false);
  const [stopStr, setStopStr] = useState('');
  const [targetStr, setTargetStr] = useState('');
  const [priceMode, setPriceMode] = useState<'market' | 'limit'>('limit');
  const [limitStr, setLimitStr] = useState('');
  const [leverage, setLeverage] = useState(10);
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
    setStopStr('');
    setTargetStr('');
    // 限价也一起清掉：换币种后留着上一个币的价格，点下去会被「价格偏离现价」拒掉
    setLimitStr('');
    autoLimitRef.current = false;
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
    if (size < sizeMin) return `张数至少 ${sizeMin}`;
    if (sizeMax > 0 && size > sizeMax) return `张数最多 ${sizeMax}`;
    if (priceMode === 'limit' && !(priceUsed > 0)) return '限价必须大于 0';
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
    if (sizing.clamped === 'afford') {
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
    if (!contract || !token) return;
    setBusy(true);
    try {
      try {
        await jsend('POST', '/api/leverage', { contract: contract.name, leverage: lev }, token);
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
      const r = await jsend<{ ok: boolean; order: { id: string; status: string; fillPrice: number }; bracket: Attach; checked: { notional: number } }>(
        'POST', '/api/order',
        {
          contract: contract.name,
          size,
          side,
          price: priceMode === 'limit' ? priceUsed : 0,
          tif: priceMode === 'market' ? 'ioc' : 'gtc',
          stop: wantProtect ? stopNum : 0,
          target: wantProtect ? targetNum : 0,
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
        <h3>下单 · {contract?.name.replace('_USDT', '') ?? '—'}</h3>
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

        <dl className="summary">
          <dt>现价</dt><dd>{fmtPrice(last, priceRound)}</dd>
          <dt>名义价值</dt><dd className={notional > 0 ? '' : 'dim'}>{notional > 0 ? fmtUsd(notional) : '—'} USDT</dd>
          <dt>占用保证金</dt><dd className={marginShort > 0 ? 'down' : ''}>{margin > 0 ? fmtUsd(margin) : '—'} USDT</dd>
          <dt>手续费</dt><dd className="dim">{notional > 0 ? fmtUsd(notional * feeRate) : '—'} USDT</dd>
          <dt>可用</dt><dd>{fmtUsd(avail)} USDT</dd>
          {marginShort > 0 && (
            <><dt>保证金差</dt><dd className="down">{fmtUsd(marginShort)} USDT</dd></>
          )}
          <dt>预估强平价</dt><dd className="dim">≈ {liqEstimate ? fmtPrice(liqEstimate, priceRound) : '—'}</dd>
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
