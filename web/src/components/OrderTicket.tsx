import { useEffect, useMemo, useState } from 'react';
import { jsend, type Account, type Bracket, type ContractInfo } from '../lib/api.ts';
import { fmtPrice, fmtUsd, fmtPct } from '../lib/format.ts';

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
}

export default function OrderTicket({
  contract, bracket, applied, armed, token, account, liveTrading, keysConfigured, env,
  riskPct, onRiskPctChange, onToast, onRefresh,
}: Props) {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeStr, setSizeStr] = useState('');
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

  // 从「自动档位」套用过来：填方向 + 限价
  useEffect(() => {
    if (!applied) return;
    setSide(applied.bracket.direction);
    setPriceMode('limit');
    setLimitStr(String(applied.bracket.entry));
    setPending(false);
  }, [applied]);

  useEffect(() => {
    setSizeStr('');
    setPending(false);
  }, [contract?.name]);

  const priceUsed = priceMode === 'limit' ? Number(limitStr) || 0 : last;
  const size = Math.round(Number(sizeStr) || 0);
  const notional = size * mult * priceUsed;
  const margin = leverage > 0 ? notional / leverage : 0;
  const avail = account?.available ?? 0;
  const maxAffordable = mult > 0 && priceUsed > 0 ? Math.floor((avail * leverage) / (mult * priceUsed)) : 0;

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

  const blocked = !contract
    ? '没有选中合约'
    : contract.tradable === false
      ? '模拟盘没有这个合约'
      : !keysConfigured
        ? '未配置 API 密钥'
        : !liveTrading
          ? '服务端 LIVE_TRADING=false，下单被禁用'
          : !armed
            ? '先点右上角解锁交易'
            : size < sizeMin
              ? `张数至少 ${sizeMin}`
              : sizeMax > 0 && size > sizeMax
                ? `张数最多 ${sizeMax}`
                : priceMode === 'limit' && !(priceUsed > 0)
                  ? '限价必须大于 0'
                  : '';

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
      const r = await jsend<{ ok: boolean; order: { id: string; status: string; fillPrice: number }; checked: { notional: number } }>(
        'POST', '/api/order',
        {
          contract: contract.name,
          size,
          side,
          price: priceMode === 'limit' ? priceUsed : 0,
          tif: priceMode === 'market' ? 'ioc' : 'gtc',
        },
        token,
      );
      onToast('ok', `下单成功 #${r.order.id}`, `${r.order.status} · 名义 ${fmtUsd(r.checked.notional)} USDT${r.order.fillPrice ? ` · 成交价 ${r.order.fillPrice}` : ''}`);
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

        <dl className="summary">
          <dt>现价</dt><dd>{fmtPrice(last, priceRound)}</dd>
          <dt>名义价值</dt><dd className={notional > 0 ? '' : 'dim'}>{notional > 0 ? fmtUsd(notional) : '—'} USDT</dd>
          <dt>占用保证金</dt><dd>{margin > 0 ? fmtUsd(margin) : '—'} USDT</dd>
          <dt>可用</dt><dd>{fmtUsd(avail)} USDT</dd>
          <dt>预估强平价</dt><dd className="dim">≈ {liqEstimate ? fmtPrice(liqEstimate, priceRound) : '—'}</dd>
          {bracket && (
            <>
              <dt>方案止损</dt>
              <dd>{fmtPrice(bracket.stop, priceRound)} <span className="dim">({fmtPct(-bracket.stopDistancePct, 2)})</span></dd>
              <dt>方案止盈</dt>
              <dd>{fmtPrice(bracket.target, priceRound)} <span className="dim">({fmtPct(bracket.targetDistancePct, 2)})</span></dd>
            </>
          )}
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
