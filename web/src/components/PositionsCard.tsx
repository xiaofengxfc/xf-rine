import { useEffect, useState } from 'react';
import {
  jsend,
  type CanceledTrades, type CloseResult, type OpenOrder, type Position, type PriceOrder,
} from '../lib/api.ts';
import { fmtMoney, fmtPrice, fmtPct, fmtUsd, fmtTime } from '../lib/format.ts';
import { multiplierOf, pnlFromCost, pnlOf } from '../lib/position.ts';
import {
  bracketOf as findBracket, dirLabel, protectionState, triggerKind, type Dir,
} from '../lib/protective.ts';

interface Props {
  positions: Position[];
  orders: OpenOrder[];
  priceOrders: PriceOrder[];
  priceRound: number;
  /** 每个合约的最小变动价。这张卡会列出别的合约的仓和委托，价格得按各自的来 */
  rounds?: ReadonlyMap<string, number>;
  /** 每个合约的最新标记价（ws 推上来的）。已盈亏按它现算，交易所也是按标记价算的 */
  marks?: ReadonlyMap<string, number>;
  /** 私有数据停更时的信息：卡片上这些仓位是旧快照 */
  stale?: { err: string; ageMs: number } | null;
  armed: boolean;
  token: string | null;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
  onRefresh: () => void;
}

/** 正在改的止损止盈。没填的那一侧表示不挂。 */
interface BracketEdit {
  contract: string;
  direction: Dir;
  stop: string;
  target: string;
}

const keyOf = (contract: string, dir: Dir) => contract + ':' + dir;

/** 平仓顺带撤掉的东西，写成一句能读的话 */
function cleanupText(c: CanceledTrades | undefined): string {
  const parts: string[] = [];
  if (c?.orders.length) parts.push('撤掉委托 ' + c.orders.length + ' 张');
  if (c?.triggers.length) parts.push('撤掉触发单 ' + c.triggers.length + ' 张');
  parts.push(...(c?.errors ?? []));
  return parts.join(' · ');
}

export default function PositionsCard({
  positions, orders, priceOrders, priceRound, rounds, marks, stale,
  armed, token, onToast, onRefresh,
}: Props) {
  /**
   * 这一行是哪个合约，就用那个合约的最小变动位显示价。
   * 在 BTC 的 0.1 底下显示 DOGE 的 0.15 会被写成 0.2 —— 一个不对的价。
   */
  const roundOf = (contract: string) => rounds?.get(contract) ?? priceRound;
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

  /** 当前这一边的止损 / 止盈（最多各一张，挂的时候是覆盖的） */
  const bracketOf = (contract: string, dir: Dir) => findBracket(priceOrders, contract, dir);

  async function closePosition(contract: string, direction: Dir) {
    if (!token) return;
    const k = keyOf(contract, direction);
    setBusy('close-' + k);
    try {
      const r = await jsend<CloseResult>('POST', '/api/close-position', { contract, direction }, token);
      const cleaned = cleanupText(r.canceled);
      onToast(
        'ok',
        '市价平仓已提交',
        contract + ' ' + dirLabel(direction) + '头' + (cleaned ? ' · ' + cleaned : ' · 没有挂着的委托要撤'),
      );
      setConfirmClose(null);
      onRefresh();
    } catch (e) {
      onToast('err', '平仓失败', (e as Error).message);
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
      const r = await jsend<{ direction: Dir; size: number; canceled?: CanceledTrades }>(
        'POST', '/api/reverse-position',
        { contract: p.contract, direction: p.direction },
        token,
      );
      const cleaned = cleanupText(r.canceled);
      onToast(
        'ok',
        '已反手',
        '平掉' + dirLabel(p.direction) + '单，现在持有 ' + r.size + ' 张' + dirLabel(r.direction) + '单'
        + (cleaned ? ' · ' + cleaned : ''),
      );
      setConfirmReverse(null);
      onRefresh();
    } catch (e) {
      // REVERSE_PARTIAL 说明已经平了、反向没开上，服务端会把这句话原样带回来
      onToast('err', '反手失败', (e as Error).message);
    } finally { setBusy(null); }
  }

  /**
   * 撤单要锁一下。
   *
   * 网络慢的时候连点两下，第二个请求回来时单已经没了，交易所报「找不到」——
   * 界面上就成了一次成功的操作报「撤单失败」，用户会再点一次。
   */
  async function cancelOrder(id: string) {
    if (!token) return;
    const tag = 'cancel-order-' + id;
    if (busy === tag) return;
    setBusy(tag);
    try {
      await jsend('DELETE', '/api/order/' + id, undefined, token);
      onToast('ok', '已撤单', id);
      if (orderEdit?.id === id) setOrderEdit(null);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
    finally { setBusy(null); }
  }

  async function cancelTrigger(id: string) {
    if (!token) return;
    const tag = 'cancel-trigger-' + id;
    if (busy === tag) return;
    setBusy(tag);
    try {
      await jsend('DELETE', '/api/price-order/' + id, undefined, token);
      onToast('ok', '已撤销触发单', id);
      onRefresh();
    } catch (e) { onToast('err', '撤单失败', (e as Error).message); }
    finally { setBusy(null); }
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

  /**
   * 把填进去的两个价换成钱。
   *
   * 「亏 12.3 USDT」比「风险 2.4%」更接近人真正在权衡的东西。这里按持仓成本、张数、
   * 乘数现算，改一个数字马上跟着变 —— 不是把服务端算好的数写死在框里。
   */
  const moneyBox = (e: BracketEdit, p: Position) => {
    const round = roundOf(e.contract);
    const mult = multiplierOf(p);
    const size = Math.abs(p.size);
    const stopNum = Number(e.stop) || 0;
    const targetNum = Number(e.target) || 0;
    const atStop = stopNum > 0 ? pnlFromCost(p.direction, p.entryPrice, size, mult, stopNum) : null;
    const atTarget = targetNum > 0 ? pnlFromCost(p.direction, p.entryPrice, size, mult, targetNum) : null;
    const risk = atStop !== null && atStop < 0 ? -atStop : 0;
    const wrongStop = stopNum > 0 && (p.direction === 'long' ? stopNum >= p.markPrice : stopNum <= p.markPrice);
    const wrongTarget = targetNum > 0 && (p.direction === 'long' ? targetNum <= p.markPrice : targetNum >= p.markPrice);
    return (
      <div className={'plan-box' + (wrongStop || wrongTarget ? ' broken' : '')}>
        <div className="plan-line">
          按持仓成本 {fmtPrice(p.entryPrice, round)} 算 · {size} 张 · {p.leverage > 0 ? `${p.leverage}x` : '全仓'}
        </div>
        <div className="plan-line">
          止损 {stopNum > 0 ? fmtPrice(stopNum, round) : '不设'} →{' '}
          <b className={atStop !== null && atStop >= 0 ? 'up' : 'down'}>
            {atStop !== null ? fmtMoney(atStop) : '—'}
          </b>
          {'　止盈 '}{targetNum > 0 ? fmtPrice(targetNum, round) : '不设'} →{' '}
          <b className={atTarget !== null && atTarget >= 0 ? 'up' : 'down'}>
            {atTarget !== null ? fmtMoney(atTarget) : '—'}
          </b>
        </div>
        {stopNum > 0 && targetNum > 0 && risk > 0 && atTarget !== null && (
          <div className="plan-line dim">成本口径盈亏比 {Math.round((atTarget / risk) * 100) / 100}</div>
        )}
        {stopNum > 0 && risk === 0 && (
          <div className="plan-line dim">止损已经在成本之上，这笔单最差也是保本</div>
        )}
        {wrongStop && <div className="plan-note warn">止损落在现价这一边，挂上去当场就成交 —— 服务端也会拒。</div>}
        {wrongTarget && <div className="plan-note warn">止盈已经跑到现价另一边了。</div>}
      </div>
    );
  };
  const editPanel = (e: BracketEdit) => {
    const wanting = Number(e.stop) > 0 || Number(e.target) > 0;
    // 有对应的持仓才画那行钱；只剩保护单、仓没了的边不画
    const pos = positions.find((x) => x.contract === e.contract && x.direction === e.direction) ?? null;
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
        {pos && moneyBox(e, pos)}
        <div className="edit-note">
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
        {stale && (
          <div className="warn-box" style={{ marginBottom: 8 }}>
            持仓/委托数据已经 {Math.round(stale.ageMs / 1000)} 秒没更新了（{stale.err}）。
            下面这些数字是那一刻的快照 —— 重新连上会自动恢复。
          </div>
        )}
        {tab === 'pos' && (
          <>
            {positions.length === 0 && <div className="empty">空仓</div>}
            {positions.map((p) => {
              const isLong = p.direction === 'long';
              const k = keyOf(p.contract, p.direction);
              // 标记价用 ws 推上来的那一份，盈亏跟着它现算 —— 每 3 秒轮询回来的那个数，
              // 价一动就已经旧了。算不出来（乘数没读到）才退回交易所给的值。
              // 停更时用快照自己的标记价，不然「旧开仓 + 新价格」会算出一个不存在的盈亏
              const mark = stale ? p.markPrice : marks?.get(p.contract) ?? p.markPrice;
              const pnl = pnlOf(p, mark);
              const pnlCls = pnl.pnl >= 0 ? 'up' : 'down';
              const cur = bracketOf(p.contract, p.direction);
              const prot = protectionState(cur);
              const round = roundOf(p.contract);
              const editing = edit && edit.contract === p.contract && edit.direction === p.direction;
              return (
                <div key={k} className={'pos ' + (isLong ? 'long' : 'short')}>
                  <div className="pos-top">
                    <span className="nm">{p.contract.replace('_USDT', '')} <span className="dim" style={{ fontSize: 10 }}>{isLong ? '多' : '空'} · {p.leverage > 0 ? `${p.leverage}x 逐仓` : '全仓'}</span></span>
                    <span className={'num ' + pnlCls}>
                      {fmtMoney(pnl.pnl)}
                      {pnl.pct !== null && <span className="dim"> ({fmtPct(pnl.pct, 2)})</span>}
                    </span>
                  </div>
                  <div className="pos-grid">
                    <div><span>张数</span><span>{Math.abs(p.size)}</span></div>
                    <div><span>开仓价</span><span>{fmtPrice(p.entryPrice, round)}</span></div>
                    <div><span>标记价</span><span>{fmtPrice(mark, round)}</span></div>
                    <div><span>强平价</span><span>{p.liqPrice > 0 ? fmtPrice(p.liqPrice, round) : '—'}</span></div>
                    <div><span>价值</span><span>{fmtUsd(p.value, 0)}</span></div>
                    <div><span>持仓模式</span><span>{p.mode === 'single' ? '单向' : p.mode === 'dual_long' ? '双向多' : p.mode === 'dual_short' ? '双向空' : p.mode}</span></div>
                  </div>

                  <div className="pos-prot">
                    <span>
                      保护{' '}
                      <span style={{ color: 'var(--down)' }}>{cur.stop ? fmtPrice(cur.stop.triggerPrice, round) : '—'}</span>
                      {' / '}
                      <span style={{ color: 'var(--up)' }}>{cur.target ? fmtPrice(cur.target.triggerPrice, round) : '—'}</span>
                    </span>
                    <span className={cur.stop || cur.target ? 'dim' : 'none'}>
                      {cur.stop || cur.target ? '到价自动平' : '没设'}
                    </span>
                  </div>
                  {/* 到期是交易所自己撤单（见服务端 PROTECT_EXPIRATION_SEC），不说就等于静默裸仓 */}
                  {prot.naked && (
                    <div className="cp-flag naked">裸仓 · 止损止盈一张都没有，点「设止损止盈」补上</div>
                  )}
                  {!prot.naked && prot.expiresAt > 0 && (
                    <div className={'cp-flag' + (prot.urgent ? ' urgent' : '')}>
                      保护 {prot.left}后由交易所自动撤销
                    </div>
                  )}

                  {editing && edit ? editPanel(edit) : confirmClose === k ? (
                    <div className="confirm">
                      <p>
                        市价平掉 {p.contract} {isLong ? '多头' : '空头'} 全部 {Math.abs(p.size)} 张？
                        这一边挂着的委托和止损止盈会一起撤掉 —— 留着的话，仓没了它们照样会成交，
                        下次开同方向的仓还会一出现就被打掉。
                      </p>
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
                          disabled={!armed}
                          title={armed ? '自己填止损止盈，不填就是不设' : '先解锁交易'}
                          onClick={() => editBracket(p)}
                        >
                          设止损止盈
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
                    {/* 显示「还剩多少」：部分成交后真正会成交的是剩余量，改单也按它算 */}
                    <span className={o.size > 0 ? 'up' : 'down'}>
                      {o.size > 0 ? '买' : '卖'} {Math.abs(o.left || o.size)}
                      {Math.abs(o.left || o.size) !== Math.abs(o.size) && (
                        <span className="dim"> / 共 {Math.abs(o.size)}</span>
                      )}
                    </span>{' '}
                    <span className="dim num">{o.price > 0 ? '@' + fmtPrice(o.price, roundOf(o.contract)) : '市价'}</span>
                  </span>
                  {/* createTime 是 unix 秒（服务端统一过单位），fmtTime 自己会乘 1000 */}
                  <span className="dim num">{fmtTime(o.createTime)}</span>
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
              // 不带 auto_size / isclose 的触发单是「到价开仓」的条件单，不是保护，别混进止损止盈里
              const protection = o.protective;
              // 仓已经没了还挂着的触发单：它不会再平任何东西，开了新仓却会第一时间打掉新仓
              const orphan = Boolean(o.direction) && !positions.some((p) => p.contract === o.contract && p.direction === o.direction);
              return (
                <div key={o.id} className="order-row">
                  <span>
                    {o.contract.replace('_USDT', '')}{' '}
                    <span className={!protection ? 'dim' : kind === 'stop' ? 'down' : kind === 'target' ? 'up' : 'dim'}>
                      {!protection ? '条件单' : kind === 'stop' ? '止损' : kind === 'target' ? '止盈' : '触发'} {fmtPrice(o.triggerPrice, roundOf(o.contract))}
                    </span>{' '}
                    <span className="dim">
                      {o.direction === 'long' ? '平多' : o.direction === 'short' ? '平空' : '平仓'} · {o.size || '全部'} 张
                    </span>
                    {orphan && (
                      <span className="orphan-note">这一边已经没有持仓了，这张单不会再平任何东西，建议撤掉</span>
                    )}
                  </span>
                  <span className="dim num">{o.id.slice(-6)}</span>
                  <span style={{ display: 'flex', gap: 2 }}>
                    <button
                      className="x edit"
                      title={!o.direction
                        ? '这张单看不出平哪一边，只能撤'
                        : !protection
                          ? '条件单不是保护单，改不了，只能撤'
                          : orphan
                            ? '这一边已经没有持仓了，挂不上新保护，这张单只能撤'
                            : '改这一边的止损止盈'}
                      // protection 只用来写文案：认不出是不是保护单的条件单确实改不了，那由「条件单不是保护单」那句说明，
                      // 但把它也塞进 disabled 会让某些服务端回成 protective:false 的保护单永远改不了，只能撤了重挂（中间还裸仓）
                      disabled={!armed || !o.direction || orphan || !protection}
                      onClick={() => {
                        if (!o.direction) return;
                        const cur = bracketOf(o.contract, dir);
                        setEdit({
                          contract: o.contract,
                          direction: dir,
                          stop: cur.stop ? String(cur.stop.triggerPrice) : '',
                          target: cur.target ? String(cur.target.triggerPrice) : '',
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
