import { Fragment, useEffect, useMemo, useState } from 'react';
import { jsend, type Account, type Bracket, type ContractInfo } from '../lib/api.ts';
import { fmtPrice, fmtUsd, fmtPct } from '../lib/format.ts';
import { protectionPrices, protectionRows, planWrongSide, type ProtectMode } from '../lib/protection.ts';

interface Props {
  contract: ContractInfo | null;
  bracket: Bracket | null;
  applied: { bracket: Bracket; at: number } | null;
  armed: boolean;
  token: string | null;
  account: Account | null;
  liveTrading: boolean;
  keysConfigured: boolean;
  env: 'testnet' | 'live';
  riskPct: number;
  onRiskPctChange: (v: number) => void;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
  onRefresh: () => void;
  /** 限价单还没成交、保护单挂不上时，把要挂的价交给页面记着 */
  onQueueProtect: (p: { contract: string; direction: 'long' | 'short'; stop: number; target: number }) => void;
}

export default function OrderTicket({
  contract, bracket, applied, armed, token, account, liveTrading, keysConfigured, env,
  riskPct, onRiskPctChange, onToast, onRefresh, onQueueProtect,
}: Props) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeStr, setSizeStr] = useState('');
  const [protect, setProtect] = useState<ProtectMode>('plan');
  const [stopStr, setStopStr] = useState('');
  const [targetStr, setTargetStr] = useState('');
  const [priceMode, setPriceMode] = useState<'market' | 'limit'>('limit');
  const [limitStr, setLimitStr] = useState('');
  const [leverage, setLeverage] = useState(10);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const mult = contract?.multiplier ?? 0;
  const last = contract?.price ?? 0;
  const priceRound = contract?.priceRound ?? 0.1;
  // Gate 有些合约把 order_size_min 报成 0（意思是没单独要求），
  // 但张数只能是正整数，照抄 0 会让「最小」按钮填个 0 进去，校验也拦不住。
  const sizeMin = Math.max(1, Math.ceil(contract?.sizeMin ?? 1));
  const levMax = Math.min(contract?.leverageMax ?? 20, 125);
  const sizeMax = Math.floor(contract?.sizeMax ?? 0);

  // 从「自动档位」套用过来：填方向 + 限价，保护直接用这套方案的价
  useEffect(() => {
    if (!applied) return;
    setSide(applied.bracket.direction);
    setPriceMode('limit');
    setLimitStr(String(applied.bracket.entry));
    setProtect('plan');
    setPending(false);
  }, [applied]);

  useEffect(() => {
    setSizeStr('');
    setPending(false);
    setStopStr('');
    setTargetStr('');
  }, [contract?.name]);

  const priceUsed = priceMode === 'limit' ? Number(limitStr) || 0 : last;
  const size = Math.round(Number(sizeStr) || 0);
  const notional = size * mult * priceUsed;
  const margin = leverage > 0 ? notional / leverage : 0;
  const avail = account?.available ?? 0;
  // 交易所按「保证金 + 手续费 ≤ 可用」放行。满仓如果只算保证金，
  // 差的正好是那几块钱手续费，点满仓必然被拒。
  const feeRate = Math.max(contract?.takerFee ?? 0, 0);
  const need = margin + notional * feeRate;
  const marginShort = need > avail ? need - avail : 0;
  const maxAffordable = mult > 0 && priceUsed > 0 && leverage > 0
    ? Math.floor(avail / (1 / leverage + feeRate) / (mult * priceUsed))
    : 0;
  /** 按同样的杠杆和可用余额，这笔最多能做多少张 */
  const affordableNow = need > 0 ? Math.floor((size * avail) / need) : 0;

  const stopNum = Number(stopStr) || 0;
  const targetNum = Number(targetStr) || 0;
  // 方案是分方向的，看多的方案不能填进卖出的单里
  const planBracket = bracket && bracket.direction === side ? bracket : null;

  // 三种保护来源最终都落成这两个价：留 0 表示这一边不挂
  const wanted = protectionPrices(protect, planBracket, stopNum, targetNum);
  // 方案价按方案入场价算，现价可能已经跑过去了，那一侧的触发单一挂上就成交。
  // 这种情况只剔掉跑过头的那一边：另一边往往还是对的，一起丢掉等于白算。
  const planWrong = planWrongSide(side, planBracket, priceUsed);
  const effStop = protect === 'plan' && planWrong.stop ? 0 : wanted.stop;
  const effTarget = protect === 'plan' && planWrong.target ? 0 : wanted.target;
  const wantProtect = effStop > 0 || effTarget > 0;

  const liqEstimate = useMemo(() => {
    if (!priceUsed || leverage <= 0) return 0;
    const move = 1 / leverage;
    return side === 'long' ? priceUsed * (1 - move) : priceUsed * (1 + move);
  }, [priceUsed, leverage, side]);

  const riskSized = useMemo(() => {
    if (!bracket || !contract || priceUsed <= 0) return 0;
    const perContract = (bracket.riskPct / 100) * bracket.entry * contract.multiplier;
    if (perContract <= 0) return 0;
    return Math.max(0, Math.floor((avail * (riskPct / 100)) / perContract));
  }, [bracket, contract, avail, riskPct, priceUsed]);

  // 拦下的第一条原因就写在按钮上。保护方式多了以后三元表达式套不下了，改成按顺序返回
  const blocked = (() => {
    if (!contract) return '没有选中合约';
    if (contract.tradable === false) return '模拟盘没有这个合约';
    if (!keysConfigured) return '未配置 API 密钥';
    if (!liveTrading) return '服务端 LIVE_TRADING=false，下单被禁用';
    if (!armed) return '先点右上角解锁交易';
    if (size < sizeMin) return `张数至少 ${sizeMin}`;
    if (sizeMax > 0 && size > sizeMax) return `张数最多 ${sizeMax}`;
    if (priceMode === 'limit' && !(priceUsed > 0)) return '限价必须大于 0';
    if (protect === 'manual' && stopNum > 0 && priceUsed > 0 && (side === 'long' ? stopNum >= priceUsed : stopNum <= priceUsed)) {
      return '止损价方向不对';
    }
    if (protect === 'manual' && targetNum > 0 && priceUsed > 0 && (side === 'long' ? targetNum <= priceUsed : targetNum >= priceUsed)) {
      return '止盈价方向不对';
    }
    return '';
  })();

  // 摘要下方那一小截：只列这一单真会挂上去的保护
  const protectRows = protectionRows(protect, side, planBracket, stopNum, targetNum, priceUsed);

  async function submit() {
    if (!contract || !token) return;
    setBusy(true);
    try {
      await jsend('POST', '/api/leverage', { contract: contract.name, leverage }, token);
    } catch (e) {
      // 杠杆设置失败不阻断下单：可能本来就是目标杠杆，或者用户没有改过
      onToast('err', '设置杠杆失败（继续下单）', (e as Error).message);
    }
    try {
      // 手动设和用方案都归到 effStop/effTarget 上，不设就是 0/0（不挂保护）
      type Attach =
        | { status: 'attached'; created: { kind: string }[] }
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
          stop: wantProtect ? effStop : 0,
          target: wantProtect ? effTarget : 0,
        },
        token,
      );
      const b = r.bracket;
      onToast(
        'ok',
        `下单成功 #${r.order.id}`,
        `${r.order.status} · 名义 ${fmtUsd(r.checked.notional)} USDT`
        + `${r.order.fillPrice ? ` · 成交价 ${r.order.fillPrice}` : ''}`
        + `${b?.status === 'attached' ? ' · 保护单已挂' : b?.status === 'pending' ? ' · 成交后自动补挂保护' : ''}`,
      );
      if (b?.status === 'failed') onToast('err', '保护单没挂上', b.error);
      if (b?.status === 'pending') onQueueProtect({ contract: contract.name, direction: side, stop: effStop, target: effTarget });
      setPending(false);
      setSizeStr('');
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
          <label>张数（{mult ? fmtUsd(mult * 1, mult < 0.01 ? 4 : mult < 1 ? 2 : 0) : '—'} 币/张）</label>
          <input
            className="input"
            inputMode="numeric"
            placeholder={`最小 ${sizeMin}`}
            value={sizeStr}
            onChange={(e) => { setSizeStr(e.target.value.replace(/[^0-9]/g, '')); setPending(false); }}
          />
        </div>

        <div className="row4" style={{ marginBottom: 10 }}>
          <button className="chip" onClick={() => { setSizeStr(String(sizeMin)); setPending(false); }}>最小</button>
          <button className="chip" onClick={() => { setSizeStr(String(Math.max(sizeMin, riskSized))); setPending(false); }} title="按可用余额 × 风险百分比 / 止损距离算">
            按风险
          </button>
          <button className="chip" onClick={() => { setSizeStr(String(Math.max(sizeMin, Math.min(maxAffordable, 50)))); setPending(false); }}>50% 仓位</button>
          <button className="chip" onClick={() => { setSizeStr(String(Math.max(sizeMin, maxAffordable))); setPending(false); }}>满仓</button>
        </div>

        <div className="row2" style={{ marginBottom: 9 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>风险 %</label>
            <input className="input sm" inputMode="decimal" value={riskPct} onChange={(e) => onRiskPctChange(Math.max(0.1, Number(e.target.value) || 0.1))} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>杠杆 {leverage}x</label>
            <input
              className="input sm"
              type="range"
              min={1}
              max={levMax}
              value={Math.min(leverage, levMax)}
              onChange={(e) => setLeverage(Number(e.target.value))}
              style={{ padding: 0, accentColor: 'var(--accent)' }}
            />
          </div>
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

        <div className="field" style={{ marginBottom: 6 }}>
          <label>止盈止损（可以不设）</label>
          <div className="seg" style={{ width: '100%' }}>
            <button className={protect === 'none' ? 'on' : ''} style={{ flex: 1 }} onClick={() => { setProtect('none'); setPending(false); }}>不设</button>
            <button
              className={protect === 'plan' ? 'on' : ''}
              style={{ flex: 1 }}
              title={planBracket ? '成交后按下面这套方案价挂止损止盈' : '这个方向还没算出方案价'}
              onClick={() => { setProtect('plan'); setPending(false); }}
            >
              方案价
            </button>
            <button className={protect === 'manual' ? 'on' : ''} style={{ flex: 1 }} onClick={() => { setProtect('manual'); setPending(false); }}>手动设</button>
          </div>
        </div>

        {protect === 'plan' && (
          planBracket ? (
            <>
              <div className="edit-note" style={{ marginBottom: 6 }}>
                成交后按下面的方案价挂，盈亏比 {planBracket.riskReward.toFixed(2)}。
                限价单还没成交就先记着，等它成交页面自动补挂。
              </div>
              {planWrong.stop && (
                <div className="edit-note" style={{ marginBottom: 6, color: 'var(--warn)' }}>
                  现价已经跑过方案止损，这一边这次不挂：触发单方向反了，挂上就成交。
                </div>
              )}
              {planWrong.target && (
                <div className="edit-note" style={{ marginBottom: 6, color: 'var(--warn)' }}>
                  现价已经跑过方案止盈，这一边这次不挂：触发单方向反了，挂上就成交。
                </div>
              )}
              {!planBracket.acceptable && (
                <div className="edit-note" style={{ marginBottom: 6, color: 'var(--warn)' }}>
                  这套方案盈亏比低于 {planBracket.minRR}，这一侧的结构不支持，最好别开。
                </div>
              )}
            </>
          ) : (
            <div className="warn-box" style={{ marginBottom: 8 }}>
              这个方向还没算出方案价（数据太少或者行情正在刷新）。换成「不设」，或者用「手动设」自己填。
            </div>
          )
        )}

        {protect === 'manual' && (
          <>
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
            <div className="edit-note">
              {planBracket && (
                <button
                  className="chip"
                  style={{ marginRight: 6 }}
                  onClick={() => { setStopStr(String(planBracket.stop)); setTargetStr(String(planBracket.target)); setPending(false); }}
                >
                  填方案价
                </button>
              )}
              成交之后才挂得上。限价单还没成交就先记着，等它成交页面自动补挂。
            </div>
            {!wantProtect && (
              <div className="edit-note" style={{ color: 'var(--warn)' }}>
                两个价都空着，这一单不带保护。
              </div>
            )}
          </>
        )}

        <dl className="summary">
          <dt>现价</dt><dd>{fmtPrice(last, priceRound)}</dd>
          <dt>名义价值</dt><dd className={notional > 0 ? '' : 'dim'}>{notional > 0 ? fmtUsd(notional) : '—'} USDT</dd>
          <dt>占用保证金</dt><dd className={marginShort > 0 ? 'down' : ''}>{margin > 0 ? fmtUsd(margin) : '—'} USDT</dd>
          <dt>可用</dt><dd>{fmtUsd(avail)} USDT</dd>
          {marginShort > 0 && (
            <><dt>保证金差</dt><dd className="down">{fmtUsd(marginShort)} USDT</dd></>
          )}
          <dt>预估强平价</dt><dd className="dim">≈ {liqEstimate ? fmtPrice(liqEstimate, priceRound) : '—'}</dd>
          {protectRows.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.price > 0 ? '' : 'dim'}>
                {row.price > 0 ? (
                  <>
                    {fmtPrice(row.price, priceRound)}
                    {row.pct !== null && <> <span className="dim">({fmtPct(row.pct, 2)})</span></>}
                  </>
                ) : row.note}
              </dd>
            </Fragment>
          ))}
        </dl>

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
              名义 <b>{fmtUsd(notional)}</b> USDT，{leverage}x 杠杆，占用保证金 {fmtUsd(margin)} USDT。
              {env === 'testnet' ? '模拟盘，扣的是测试网假钱。' : '这是真实资金。'}
            </p>
            {wantProtect && (
              <p className="dim" style={{ fontSize: 11 }}>
                成交后挂保护（{protect === 'plan' ? '方案价' : '手动设'}）：
                {effStop > 0 ? `止损 ${fmtPrice(effStop, priceRound)}` : ''}
                {effStop > 0 && effTarget > 0 ? ' / ' : ''}
                {effTarget > 0 ? `止盈 ${fmtPrice(effTarget, priceRound)}` : ''}
              </p>
            )}
            {marginShort > 0 && (
              <p className="warn">
                保证金不够：连手续费要 {fmtUsd(need)} USDT，可用只有 {fmtUsd(avail)} USDT，差 {fmtUsd(marginShort)} USDT。
                按同样的杠杆最多做 {affordableNow} 张，或者把杠杆调高。
              </p>
            )}
            <div className="acts">
              <button className="btn ghost" onClick={() => setPending(false)} disabled={busy}>取消</button>
              <button className={`btn ${side}`} onClick={submit} disabled={busy}>
                {busy ? '下单中…' : env === 'testnet' ? '确认模拟下单' : '确认下单'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
