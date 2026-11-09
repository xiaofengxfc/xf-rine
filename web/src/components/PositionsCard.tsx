import { useEffect, useState } from 'react';
import { jsend, type Bracket, type OpenOrder, type Position, type PriceOrder } from '../lib/api.ts';
import { fmtPrice, fmtUsd, fmtTime } from '../lib/format.ts';

interface Props {
  positions: Position[];
  orders: OpenOrder[];
  priceOrders: PriceOrder[];
  currentContract: string;
  longBracket: Bracket | null;
  shortBracket: Bracket | null;
  priceRound: number;
  armed: boolean;
  token: string | null;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
  onRefresh: () => void;
}

export default function PositionsCard({
  positions, orders, priceOrders, currentContract, longBracket, shortBracket, priceRound,
  armed, token, onToast, onRefresh,
}: Props) {
  const [tab, setTab] = useState<'pos' | 'ord' | 'trig'>('pos');
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { setConfirmClose(null); }, [positions.length]);

  async function closePosition(contract: string, direction: 'long' | 'short') {
    if (!token) return;
    setBusy(contract + direction);
    try {
      await jsend('POST', '/api/close-position', { contract, direction }, token);
      onToast('ok', '市价平仓已提交', `${contract} ${direction === 'long' ? '多头' : '空头'}`);
      setConfirmClose(null);
      onRefresh();
    } catch (e) {
      onToast('err', '平仓失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function attachBracket(p: Position) {
    if (!token) return;
    const b = p.direction === 'long' ? longBracket : shortBracket;
    if (!b || p.contract !== currentContract) {
      onToast('err', '没有可用方案', '先把合约切到该持仓的合约，等自动档位算出来再挂');
      return;
    }
    setBusy('br-' + p.contract + p.direction);
    try {
      const r = await jsend<{ ok: boolean; created: { kind: string; id: string; triggerPrice: number }[]; errors: string[] }>(
        'POST', '/api/bracket',
        { contract: p.contract, direction: p.direction, stop: b.stop, target: b.target, size: Math.abs(p.size) },
        token,
      );
      onToast('ok', `已挂 ${r.created.length} 张触发单`, r.errors.length ? '部分失败：' + r.errors.join('；') : '止损止盈已生效');
      onRefresh();
    } catch (e) {
      onToast('err', '挂止损止盈失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function cancelOrder(id: string) {
    if (!token) return;
    try {
      await jsend('DELETE', `/api/order/${id}`, undefined, token);
      onToast('ok', '已撤单', id);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
  }

  async function cancelTrigger(id: string) {
    if (!token) return;
    try {
      await jsend('DELETE', `/api/price-order/${id}`, undefined, token);
      onToast('ok', '已撤销触发单', id);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>仓位</h3>
        <div className="seg">
          <button className={tab === 'pos' ? 'on' : ''} onClick={() => setTab('pos')}>持仓 {positions.length || ''}</button>
          <button className={tab === 'ord' ? 'on' : ''} onClick={() => setTab('ord')}>委托 {orders.length || ''}</button>
          <button className={tab === 'trig' ? 'on' : ''} onClick={() => setTab('trig')}>触发 {priceOrders.length || ''}</button>
        </div>
      </div>
      <div className="card-body">
        {tab === 'pos' && (
          <>
            {positions.length === 0 && <div className="empty">空仓</div>}
            {positions.map((p) => {
              const isLong = p.direction === 'long';
              const pnlCls = p.unrealisedPnl >= 0 ? 'up' : 'down';
              return (
                <div key={`${p.contract}-${p.direction}`} className={`pos ${isLong ? 'long' : 'short'}`}>
                  <div className="pos-top">
                    <span className="nm">{p.contract.replace('_USDT', '')} <span className="dim" style={{ fontSize: 10 }}>{isLong ? '多' : '空'} · {p.leverage}x</span></span>
                    <span className={`num ${pnlCls}`}>{fmtUsd(p.unrealisedPnl)}</span>
                  </div>
                  <div className="pos-grid">
                    <div><span>张数</span><span>{Math.abs(p.size)}</span></div>
                    <div><span>开仓价</span><span>{fmtPrice(p.entryPrice, priceRound)}</span></div>
                    <div><span>标记价</span><span>{fmtPrice(p.markPrice, priceRound)}</span></div>
                    <div><span>强平价</span><span>{p.liqPrice > 0 ? fmtPrice(p.liqPrice, priceRound) : '—'}</span></div>
                    <div><span>价值</span><span>{fmtUsd(p.value, 0)}</span></div>
                    <div><span>持仓模式</span><span>{p.mode === 'single' ? '单向' : p.mode === 'dual_long' ? '双向多' : p.mode === 'dual_short' ? '双向空' : p.mode}</span></div>
                  </div>
                  {confirmClose === p.contract + p.direction ? (
                    <div className="confirm" style={{ marginTop: 4 }}>
                      <p>市价平掉 {p.contract} {isLong ? '多头' : '空头'} 全部 {Math.abs(p.size)} 张？</p>
                      <div className="acts">
                        <button className="btn ghost" onClick={() => setConfirmClose(null)}>取消</button>
                        <button className="btn danger" onClick={() => closePosition(p.contract, p.direction)} disabled={busy === p.contract + p.direction}>确认平仓</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <button className="btn ghost" style={{ padding: '5px 0', fontSize: 11 }} disabled={!armed || busy === 'br-' + p.contract + p.direction} onClick={() => attachBracket(p)} title={armed ? '按自动档位挂价格触发单' : '先解锁交易'}>
                        挂自动止损止盈
                      </button>
                      <button className="btn danger" style={{ padding: '5px 0', fontSize: 11 }} disabled={!armed} onClick={() => setConfirmClose(p.contract + p.direction)}>
                        市价平仓
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {tab === 'ord' && (
          <>
            {orders.length === 0 && <div className="empty">没有未成交委托</div>}
            {orders.map((o) => (
              <div key={o.id} className="order-row">
                <span>
                  {o.contract.replace('_USDT', '')}{' '}
                  <span className={o.size > 0 ? 'up' : 'down'}>{o.size > 0 ? '买' : '卖'} {Math.abs(o.size)}</span>{' '}
                  <span className="dim num">{o.price > 0 ? '@' + fmtPrice(o.price, priceRound) : '市价'}</span>
                </span>
                <span className="dim num">{fmtTime(o.createTime / 1e6)}</span>
                <button className="x" title="撤单" disabled={!armed} onClick={() => cancelOrder(o.id)}>×</button>
              </div>
            ))}
          </>
        )}

        {tab === 'trig' && (
          <>
            {priceOrders.length === 0 && <div className="empty">没有挂着的止损止盈</div>}
            {priceOrders.map((o) => (
              <div key={o.id} className="order-row">
                <span>
                  {o.contract.replace('_USDT', '')}{' '}
                  <span className={o.triggerRule === 1 ? 'up' : 'down'}>
                    {o.triggerRule === 1 ? '≥' : '≤'} {fmtPrice(o.triggerPrice, priceRound)}
                  </span>{' '}
                  <span className="dim">{o.direction === 'long' ? '平多' : o.direction === 'short' ? '平空' : '平仓'} · {o.size || '全部'} 张</span>
                </span>
                <span className="dim num">{o.id.slice(-6)}</span>
                <button className="x" title="撤销" disabled={!armed} onClick={() => cancelTrigger(o.id)}>×</button>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
