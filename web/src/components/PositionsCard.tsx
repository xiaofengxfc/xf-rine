import { useEffect, useState } from 'react';
import {
  jget, jsend,
  type Bracket, type LevelsResponse, type OpenOrder, type Position, type PriceOrder,
} from '../lib/api.ts';
import { fmtPrice, fmtUsd, fmtTime } from '../lib/format.ts';

type Dir = 'long' | 'short';

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

/** 正在改的保护单。没填的那一侧表示不挂。 */
interface BracketEdit {
  contract: string;
  direction: Dir;
  stop: string;
  target: string;
  /** 值是从自动方案填进来的（只是提示文案，不影响怎么挂） */
  fromPlan: boolean;
}

const keyOf = (contract: string, dir: Dir) => contract + ':' + dir;
const dirLabel = (d: Dir) => (d === 'long' ? '多' : '空');

/**
 * 一张触发单是止损还是止盈。
 * Gate 的 rule 只看价格走向：1 = 价格 >= 触发价，2 = 价格 <= 触发价。
 * 所以对多头 rule 1 是止盈、rule 2 是止损，对空头正好反过来。
 */
function triggerKind(o: PriceOrder, dir: Dir): 'stop' | 'target' {
  const up = o.triggerRule === 1;
  if (dir === 'long') return up ? 'target' : 'stop';
  return up ? 'stop' : 'target';
}

export default function PositionsCard({
  positions, orders, priceOrders, currentContract, longBracket, shortBracket, priceRound,
  armed, token, onToast, onRefresh,
}: Props) {
  const [tab, setTab] = useState<'pos' | 'ord' | 'trig'>('pos');
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmReverse, setConfirmReverse] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: string; size: string } | null>(null);
  const [edit, setEdit] = useState<BracketEdit | null>(null);
  const [orderEdit, setOrderEdit] = useState<{ id: string; price: string; size: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 仓没了就把对着它弹的确认收掉，别让人对着旧数字点确认
  useEffect(() => {
    const keys = new Set(positions.map((p) => keyOf(p.contract, p.direction)));
    setConfirmClose((k) => (k && keys.has(k) ? k : null));
    setConfirmReverse((k) => (k && keys.has(k) ? k : null));
    setEdit((e) => (e && keys.has(keyOf(e.contract, e.direction)) ? e : null));
  }, [positions]);

  // 正在改的那张委托没了（成交或撤掉）就把编辑框收掉
  useEffect(() => {
    setOrderEdit((cur) => (cur && orders.some((o) => o.id === cur.id) ? cur : null));
  }, [orders]);

  const triggersOf = (contract: string, dir: Dir) =>
    priceOrders.filter((o) => o.contract === contract && o.direction === dir);

  /** 当前这一边的止损 / 止盈（最多各一张，挂的时候是覆盖的） */
  const bracketOf = (contract: string, dir: Dir) => {
    const rows = triggersOf(contract, dir);
    return {
      stop: rows.find((o) => triggerKind(o, dir) === 'stop') ?? null,
      target: rows.find((o) => triggerKind(o, dir) === 'target') ?? null,
    };
  };

  async function closePosition(contract: string, direction: Dir) {
    if (!token) return;
    const k = keyOf(contract, direction);
    setBusy('close-' + k);
    try {
      await jsend('POST', '/api/close-position', { contract, direction }, token);
      onToast('ok', '市价平仓已提交', contract + ' ' + (direction === 'long' ? '多头' : '空头'));
      setConfirmClose(null);
      onRefresh();
    } catch (e) {
      onToast('err', '平仓失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  /** 套用方案：当前合约直接用页面上的档位，别的合约现拉一次 */
  async function usePlan(p: Position) {
    const k = keyOf(p.contract, p.direction);
    setBusy('plan-' + k);
    try {
      let b: Bracket | null = null;
      if (p.contract === currentContract) {
        b = p.direction === 'long' ? longBracket : shortBracket;
      } else {
        const lv = await jget<LevelsResponse>(
          '/api/levels?contract=' + encodeURIComponent(p.contract) + '&interval=15m&limit=500',
        );
        b = p.direction === 'long' ? lv.brackets.long : lv.brackets.short;
      }
      if (!b) {
        onToast('err', '这一侧没有方案', '结构不支持给止损止盈，自己填一个价位吧');
        setEdit({ contract: p.contract, direction: p.direction, stop: '', target: '', fromPlan: false });
        return;
      }
      setEdit({ contract: p.contract, direction: p.direction, stop: String(b.stop), target: String(b.target), fromPlan: true });
    } catch (e) {
      onToast('err', '取方案失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  /** 自己设：把现在挂着的填进去，改哪个填哪个 */
  function editBracket(p: Position) {
    const cur = bracketOf(p.contract, p.direction);
    setEdit({
      contract: p.contract,
      direction: p.direction,
      stop: cur.stop ? String(cur.stop.triggerPrice) : '',
      target: cur.target ? String(cur.target.triggerPrice) : '',
      fromPlan: false,
    });
  }

  /**
   * 保存保护单。服务端是覆盖语义：先撤这一边已有的，再挂填了的。
   * 两个都留空就是只要撤掉、不挂新的。
   */
  async function saveBracket() {
    if (!edit || !token) return;
    const stop = Number(edit.stop) || 0;
    const target = Number(edit.target) || 0;
    const k = keyOf(edit.contract, edit.direction);
    setBusy('save-' + k);
    try {
      const r = await jsend<{ created: { kind: string }[]; canceled: string[]; errors: string[] }>(
        'POST', '/api/bracket',
        { contract: edit.contract, direction: edit.direction, stop, target },
        token,
      );
      const wanting = stop > 0 || target > 0;
      const parts = [
        r.canceled.length ? '撤掉旧保护 ' + r.canceled.length + ' 张' : '',
        r.created.length ? '新挂 ' + r.created.length + ' 张' : (wanting ? '没有新挂上' : ''),
        ...r.errors,
      ].filter(Boolean);
      onToast(
        r.errors.length ? 'err' : 'ok',
        r.errors.length ? '部分失败' : wanting ? '止损止盈已覆盖' : '保护已撤掉',
        parts.join(' · ') || '没有变化',
      );
      setEdit(null);
      onRefresh();
    } catch (e) {
      onToast('err', '挂止损止盈失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function addPosition(p: Position) {
    if (!token || !adding) return;
    const qty = Math.round(Number(adding.size));
    if (!(qty > 0)) { onToast('err', '张数不对', '填一个正整数'); return; }
    const k = keyOf(p.contract, p.direction);
    setBusy('add-' + k);
    try {
      const r = await jsend<{ order: { id: string; status: string; fillPrice: number } }>(
        'POST', '/api/add-position',
        { contract: p.contract, direction: p.direction, size: qty },
        token,
      );
      onToast('ok', '加仓 ' + qty + ' 张已提交', p.contract + ' ' + dirLabel(p.direction) + '单 · ' + r.order.status);
      setAdding(null);
      onRefresh();
    } catch (e) {
      onToast('err', '加仓失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function reversePosition(p: Position) {
    if (!token) return;
    const k = keyOf(p.contract, p.direction);
    setBusy('rev-' + k);
    try {
      const r = await jsend<{ direction: Dir; size: number }>(
        'POST', '/api/reverse-position',
        { contract: p.contract, direction: p.direction },
        token,
      );
      onToast('ok', '已反手', '平掉' + dirLabel(p.direction) + '单，现在持有 ' + r.size + ' 张' + dirLabel(r.direction) + '单');
      setConfirmReverse(null);
      onRefresh();
    } catch (e) {
      // REVERSE_PARTIAL 说明已经平了、反向没开上，服务端会把这句话原样带回来
      onToast('err', '反手失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function cancelOrder(id: string) {
    if (!token) return;
    try {
      await jsend('DELETE', '/api/order/' + id, undefined, token);
      onToast('ok', '已撤单', id);
      if (orderEdit?.id === id) setOrderEdit(null);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
  }

  async function cancelTrigger(id: string) {
    if (!token) return;
    try {
      await jsend('DELETE', '/api/price-order/' + id, undefined, token);
      onToast('ok', '已撤销触发单', id);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
  }

  async function saveOrderEdit() {
    if (!token || !orderEdit) return;
    const price = Number(orderEdit.price) || 0;
    const size = Math.round(Number(orderEdit.size)) || 0;
    if (!(price > 0)) { onToast('err', '价格不对', '填一个大于 0 的限价'); return; }
    setBusy('amend-' + orderEdit.id);
    try {
      const r = await jsend<{ replaced: { oldId: string; id: string; price: number; size: number; status: string } }>(
        'POST', '/api/order/' + orderEdit.id + '/amend',
        { price, size },
        token,
      );
      onToast('ok', '改单完成，新委托号 #' + r.replaced.id, '旧单已撤 · ' + Math.abs(r.replaced.size) + ' 张 @' + r.replaced.price);
      setOrderEdit(null);
      onRefresh();
    } catch (e) {
      onToast('err', '改单失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  const editPanel = (e: BracketEdit) => {
    const wanting = Number(e.stop) > 0 || Number(e.target) > 0;
    return (
      <div className="bracket-edit">
        <div className="row2">
          <div className="field">
            <label>止损价（可空）</label>
            <input
              className="input sm"
              inputMode="decimal"
              placeholder="不设就空着"
              value={e.stop}
              onChange={(ev) => setEdit({ ...e, stop: ev.target.value.replace(/[^0-9.]/g, '') })}
            />
          </div>
          <div className="field">
            <label>止盈价（可空）</label>
            <input
              className="input sm"
              inputMode="decimal"
              placeholder="不设就空着"
              value={e.target}
              onChange={(ev) => setEdit({ ...e, target: ev.target.value.replace(/[^0-9.]/g, '') })}
            />
          </div>
        </div>
        <div className="edit-note">
          {e.fromPlan ? '已填入自动方案的结构价，可以直接改。' : ''}
          保存会先撤掉这一边现有的保护单再挂。两个都留空 = 只要撤掉、不挂新的。
        </div>
        <div className="acts">
          <button
            className={'btn ' + (wanting ? 'accent' : 'danger')}
            disabled={!armed || busy === 'save-' + keyOf(e.contract, e.direction)}
            onClick={saveBracket}
          >
            {busy === 'save-' + keyOf(e.contract, e.direction) ? '提交中…' : wanting ? '覆盖挂上' : '撤掉保护'}
          </button>
          <button className="btn ghost" onClick={() => setEdit(null)}>取消</button>
        </div>
      </div>
    );
  };

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
              const k = keyOf(p.contract, p.direction);
              const pnlCls = p.unrealisedPnl >= 0 ? 'up' : 'down';
              const cur = bracketOf(p.contract, p.direction);
              const editing = edit && edit.contract === p.contract && edit.direction === p.direction;
              return (
                <div key={k} className={'pos ' + (isLong ? 'long' : 'short')}>
                  <div className="pos-top">
                    <span className="nm">{p.contract.replace('_USDT', '')} <span className="dim" style={{ fontSize: 10 }}>{isLong ? '多' : '空'} · {p.leverage}x</span></span>
                    <span className={'num ' + pnlCls}>{fmtUsd(p.unrealisedPnl)}</span>
                  </div>
                  <div className="pos-grid">
                    <div><span>张数</span><span>{Math.abs(p.size)}</span></div>
                    <div><span>开仓价</span><span>{fmtPrice(p.entryPrice, priceRound)}</span></div>
                    <div><span>标记价</span><span>{fmtPrice(p.markPrice, priceRound)}</span></div>
                    <div><span>强平价</span><span>{p.liqPrice > 0 ? fmtPrice(p.liqPrice, priceRound) : '—'}</span></div>
                    <div><span>价值</span><span>{fmtUsd(p.value, 0)}</span></div>
                    <div><span>持仓模式</span><span>{p.mode === 'single' ? '单向' : p.mode === 'dual_long' ? '双向多' : p.mode === 'dual_short' ? '双向空' : p.mode}</span></div>
                  </div>

                  <div className="pos-prot">
                    <span>
                      保护{' '}
                      <span style={{ color: 'var(--down)' }}>{cur.stop ? fmtPrice(cur.stop.triggerPrice, priceRound) : '—'}</span>
                      {' / '}
                      <span style={{ color: 'var(--up)' }}>{cur.target ? fmtPrice(cur.target.triggerPrice, priceRound) : '—'}</span>
                    </span>
                    <span className={cur.stop || cur.target ? 'dim' : 'none'}>
                      {cur.stop || cur.target ? '到价自动平' : '没设'}
                    </span>
                  </div>

                  {editing && edit ? editPanel(edit) : confirmClose === k ? (
                    <div className="confirm">
                      <p>市价平掉 {p.contract} {isLong ? '多头' : '空头'} 全部 {Math.abs(p.size)} 张？</p>
                      <div className="acts">
                        <button className="btn ghost" onClick={() => setConfirmClose(null)}>取消</button>
                        <button className="btn danger" onClick={() => closePosition(p.contract, p.direction)} disabled={busy === 'close-' + k}>
                          {busy === 'close-' + k ? '平仓中…' : '确认平仓'}
                        </button>
                      </div>
                    </div>
                  ) : confirmReverse === k ? (
                    <div className="confirm">
                      <p>
                        市价平掉 {Math.abs(p.size)} 张{isLong ? '多' : '空'}单，马上反向开 {Math.abs(p.size)} 张{isLong ? '空' : '多'}单。
                        分两步走：平仓没成交会停手，不会多开一边。
                      </p>
                      <div className="acts">
                        <button className="btn ghost" onClick={() => setConfirmReverse(null)}>取消</button>
                        <button className="btn accent" onClick={() => reversePosition(p)} disabled={busy === 'rev-' + k}>
                          {busy === 'rev-' + k ? '反手中…' : '确认反手'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="pos-acts two">
                        <button
                          className="btn ghost"
                          disabled={!armed || busy === 'plan-' + k}
                          title={armed ? '用自动识别出的止损止盈覆盖现在挂着的' : '先解锁交易'}
                          onClick={() => usePlan(p)}
                        >
                          {busy === 'plan-' + k ? '取方案…' : '套用方案'}
                        </button>
                        <button
                          className="btn ghost"
                          disabled={!armed}
                          title={armed ? '自己填止损止盈，不填就是不设' : '先解锁交易'}
                          onClick={() => editBracket(p)}
                        >
                          自己设保护
                        </button>
                      </div>

                      {adding && adding.key === k ? (
                        <div className="pos-acts two">
                          <input
                            className="input sm"
                            inputMode="numeric"
                            placeholder="张数"
                            value={adding.size}
                            onChange={(ev) => setAdding({ key: k, size: ev.target.value.replace(/[^0-9]/g, '') })}
                          />
                          <button className={'btn ' + (isLong ? 'long' : 'short')} disabled={busy === 'add-' + k} onClick={() => addPosition(p)}>
                            {busy === 'add-' + k ? '提交中…' : '市价加仓'}
                          </button>
                        </div>
                      ) : (
                        <div className="pos-acts">
                          <button
                            className="btn ghost"
                            disabled={!armed}
                            title={armed ? '按市价在这一边加张数' : '先解锁交易'}
                            onClick={() => setAdding({ key: k, size: String(Math.max(1, Math.round(Math.abs(p.size) / 2))) })}
                          >
                            加仓
                          </button>
                          <button className="btn ghost" disabled={!armed} title={armed ? '平掉这一边，再反向开同样的张数' : '先解锁交易'} onClick={() => setConfirmReverse(k)}>
                            反手
                          </button>
                          <button className="btn danger" disabled={!armed} onClick={() => setConfirmClose(k)}>平仓</button>
                        </div>
                      )}
                    </>
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
              orderEdit?.id === o.id ? (
                <div key={o.id} className="order-edit">
                  <div className="row2">
                    <div className="field">
                      <label>限价</label>
                      <input
                        className="input sm"
                        inputMode="decimal"
                        value={orderEdit.price}
                        onChange={(ev) => setOrderEdit({ ...orderEdit, price: ev.target.value.replace(/[^0-9.]/g, '') })}
                      />
                    </div>
                    <div className="field">
                      <label>剩余张数（≤ {Math.abs(o.left || o.size)}）</label>
                      <input
                        className="input sm"
                        inputMode="numeric"
                        value={orderEdit.size}
                        onChange={(ev) => setOrderEdit({ ...orderEdit, size: ev.target.value.replace(/[^0-9]/g, '') })}
                      />
                    </div>
                  </div>
                  <div className="edit-note">先按新条件验一遍，验过了才撤旧单重挂 —— 委托号会变。</div>
                  <div className="acts">
                    <button className="btn accent" disabled={busy === 'amend-' + o.id} onClick={saveOrderEdit}>
                      {busy === 'amend-' + o.id ? '改单中…' : '保存并重挂'}
                    </button>
                    <button className="btn ghost" onClick={() => setOrderEdit(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div key={o.id} className="order-row">
                  <span>
                    {o.contract.replace('_USDT', '')}{' '}
                    <span className={o.size > 0 ? 'up' : 'down'}>{o.size > 0 ? '买' : '卖'} {Math.abs(o.size)}</span>{' '}
                    <span className="dim num">{o.price > 0 ? '@' + fmtPrice(o.price, priceRound) : '市价'}</span>
                  </span>
                  <span className="dim num">{fmtTime(o.createTime / 1e6)}</span>
                  <span style={{ display: 'flex', gap: 2 }}>
                    <button
                      className="x edit"
                      title="改价 / 改量"
                      disabled={!armed}
                      onClick={() => setOrderEdit({
                        id: o.id,
                        price: o.price > 0 ? String(o.price) : '',
                        size: String(Math.abs(o.left || o.size)),
                      })}
                    >
                      ✎
                    </button>
                    <button className="x" title="撤单" disabled={!armed} onClick={() => cancelOrder(o.id)}>×</button>
                  </span>
                </div>
              )
            ))}
          </>
        )}

        {tab === 'trig' && (
          <>
            {edit && (
              <>
                <div className="dim" style={{ fontSize: 10, margin: '2px 0 4px' }}>
                  改 {edit.contract.replace('_USDT', '')} {dirLabel(edit.direction)}单的保护
                </div>
                {editPanel(edit)}
              </>
            )}
            {priceOrders.length === 0 && <div className="empty">没有挂着的止损止盈</div>}
            {priceOrders.map((o) => {
              const dir = (o.direction || 'long') as Dir;
              // 交易所网页上挂的单认不出平哪一边，别硬猜成止损或止盈
              const kind = o.direction ? triggerKind(o, dir) : null;
              return (
                <div key={o.id} className="order-row">
                  <span>
                    {o.contract.replace('_USDT', '')}{' '}
                    <span className={kind === 'stop' ? 'down' : kind === 'target' ? 'up' : 'dim'}>
                      {kind === 'stop' ? '止损' : kind === 'target' ? '止盈' : '触发'} {fmtPrice(o.triggerPrice, priceRound)}
                    </span>{' '}
                    <span className="dim">
                      {o.direction === 'long' ? '平多' : o.direction === 'short' ? '平空' : '平仓'} · {o.size || '全部'} 张
                    </span>
                  </span>
                  <span className="dim num">{o.id.slice(-6)}</span>
                  <span style={{ display: 'flex', gap: 2 }}>
                    <button
                      className="x edit"
                      title={o.direction ? '改这一边的止损止盈' : '这张单看不出平哪一边，只能撤'}
                      disabled={!armed || !o.direction}
                      onClick={() => {
                        if (!o.direction) return;
                        const cur = bracketOf(o.contract, dir);
                        setEdit({
                          contract: o.contract,
                          direction: dir,
                          stop: cur.stop ? String(cur.stop.triggerPrice) : '',
                          target: cur.target ? String(cur.target.triggerPrice) : '',
                          fromPlan: false,
                        });
                      }}
                    >
                      ✎
                    </button>
                    <button className="x" title="撤销" disabled={!armed} onClick={() => cancelTrigger(o.id)}>×</button>
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}
