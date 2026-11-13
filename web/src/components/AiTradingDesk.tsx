
import { useCallback, useEffect, useMemo, useState } from 'react';
import { jget, jsend } from '../lib/api.ts';
import type {
  AiDecisionRecord, AiStrategy, AiStrategyPayload, AiRunnerStatus,
} from '../lib/api.ts';
import { fmtPrice } from '../lib/format.ts';

interface Props {
  /** 当前环境。实盘要额外确认一次 */
  env: 'testnet' | 'live';
  /** 服务端的下单总开关。关着的时候 AI 也发不出单，页面要说出来 */
  liveTrading: boolean;
  /** 只有本机能改策略（写配置＝控制钱） */
  canEdit: boolean;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
}

type Busy = '' | 'save' | 'toggle' | 'decide' | 'halt';

function timeStr(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function agoStr(ts: number): string {
  if (!ts) return '还没做过';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return Math.round(s / 3600) + ' 小时前';
}

/**
 * AI 交易台。
 *
 * 这一页只有一件事：**开着的时候，它自己按策略下单；关掉就什么都不做**。
 * 没有「只出建议再手动点一下」这条路 —— 那等于把决策权又塞回给人，
 * 而人盯不住每十五分钟一次的判断。
 *
 * 所以页面要做的是让人在开着的时候看得见三件事：
 *   1. 它现在凭什么做/不做（风控闸门逐条判定，模型的原话都在）；
 *   2. 这一单实际开了多大（张数是代码算的，不是模型说的）；
 *   3. 停下来的时候是被谁停的（冷却、仓位满、日内亏损熔断、手动急停）。
 */
export default function AiTradingDesk({ env, liveTrading, canEdit, onToast }: Props) {
  const [payload, setPayload] = useState<AiStrategyPayload | null>(null);
  const [records, setRecords] = useState<AiDecisionRecord[]>([]);
  const [form, setForm] = useState<AiStrategy | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  const [err, setErr] = useState('');
  const [openTurns, setOpenTurns] = useState<Record<string, boolean>>({});

  const applyPayload = useCallback((p: AiStrategyPayload, keepForm: boolean) => {
    setPayload(p);
    if (!keepForm) {
      setForm(p.strategy);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const p = await jget<AiStrategyPayload>('/api/ai/strategy');
      applyPayload(p, false);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [applyPayload]);

  const loadDecisions = useCallback(async () => {
    try {
      const r = await jget<{ records: AiDecisionRecord[]; status: AiRunnerStatus }>('/api/ai/decisions?limit=40');
      setRecords(r.records);
    } catch { /* 列表拉不到不影响表单 */ }
  }, []);

  useEffect(() => { void load(); void loadDecisions(); }, [load, loadDecisions]);

  // 每 6 秒对一次状态和决策流。这一页看的是「它现在在干什么」，慢一拍就会误判
  useEffect(() => {
    const id = window.setInterval(() => { void loadDecisions(); }, 6000);
    return () => window.clearInterval(id);
  }, [loadDecisions]);

  const status = payload?.status ?? null;
  const dirty = Boolean(form && payload && JSON.stringify(form) !== JSON.stringify(payload.strategy));

  const patch = useCallback((p: Partial<AiStrategy>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
  }, []);

  /**
   * 把表单拼成一次请求。enabled 由调用方决定，不从表单里读。
   *
   * 不再传 contracts：合约池由 strategyId 推导，服务端不认手填的那份。
   */
  const submit = useCallback(async (enabled: boolean, extra: Record<string, unknown> = {}) => {
    if (!form) return null;
    const body = { ...form, ...extra, enabled };
    const p = await jsend<AiStrategyPayload>('POST', '/api/ai/strategy', body);
    applyPayload(p, true);
    return p;
  }, [form, applyPayload]);

  const save = useCallback(async () => {
    setBusy('save');
    try {
      const p = await submit(Boolean(form?.enabled));
      if (p) { applyPayload(p, false); onToast('ok', '策略已保存'); }
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [submit, form, applyPayload, onToast]);

  const toggle = useCallback(async (wantOn: boolean) => {
    if (!form) return;
    setBusy('toggle');
    try {
      const p = await submit(wantOn);
      if (p) {
        applyPayload(p, false);
        onToast('ok', wantOn ? 'AI 交易已开始' : 'AI 交易已停止',
          wantOn ? '每隔 ' + p.strategy.cooldownMin + ' 分钟看一个合约' : '定时器已停，不会再发任何请求');
      }
    } catch (e) {
      onToast('err', wantOn ? '没能开始' : '没能停止', (e as Error).message);
    } finally { setBusy(''); }
  }, [submit, form, applyPayload, onToast]);

  const halt = useCallback(async (withHalt: boolean) => {
    setBusy('halt');
    try {
      const r = await jsend<{ ok: boolean; strategy: AiStrategy; status: AiRunnerStatus }>(
        'POST', '/api/ai/halt', { halt: withHalt },
      );
      setForm(r.strategy);
      await load();
      await loadDecisions();
      onToast('ok', withHalt ? '已急停并熔断 24 小时' : '已急停', '策略和日志都留着，随时可以再开');
    } catch (e) {
      onToast('err', '急停失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [load, loadDecisions, onToast]);

  const decideNow = useCallback(async () => {
    setBusy('decide');
    try {
      const r = await jsend<{ ok: boolean; skip?: string; record?: AiDecisionRecord }>(
        'POST', '/api/ai/decide', {}, undefined, AbortSignal.timeout(180_000),
      );
      await loadDecisions();
      if (!r.ok) onToast('err', '这一轮没做决策', r.skip || '未知原因');
      else onToast('ok', '这一轮做完了', r.record?.exec.ok ? '已下单' : '没有发单，原因在决策流里');
    } catch (e) {
      onToast('err', '决策失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [loadDecisions, onToast]);

  const on = Boolean(payload?.strategy.enabled);
  const halted = Boolean(status && status.haltUntil > Date.now());

  /**
   * 能不能开。
   *
   * 三个条件缺一不可：选了策略、策略跑过回测、回测样本够且达标。
   * 服务端也会再拦一次（那才是权威），这里只是别让人对着一个能点、点了必然报错的按钮。
   */
  const binding = payload?.binding ?? null;
  const whyNotReady = !form?.strategyId
    ? '先选一条策略'
    : !binding
      ? '选中的策略不在了，重新选一条'
      : binding.passed === null
        ? '这条策略还没跑过回测，到「策略」页按一次回测'
        : !binding.enoughSample
          ? '回测样本不够 30 笔，判定不可信，不能开'
          : !binding.passed
            ? '这条策略上次回测没过：' + (binding.failed.join('、') || '原因不明')
            : '';
  const readyToRun = whyNotReady === '';
  const counts = status?.counts ?? { decisions: 0, orders: 0, refusals: 0, errors: 0 };

  const title = useMemo(() => {
    if (!status) return '加载中';
    if (halted) return '熔断中';
    return on ? '运行中' : '已停止';
  }, [status, halted, on]);

  if (err && !payload) {
    return (
      <div className="ai-desk">
        <div className="panel">
          <div className="panel-head"><span className="panel-title">AI 交易</span></div>
          <div className="panel-foot">
            <div className="warn-box">读不到策略：{err}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-desk">
      {/* ---------- 顶部：开没开、在干什么 ---------- */}
      <div className="panel ai-top">
        <div className="ai-top-main">
          <div className="ai-state">
            <i className={'status-dot ' + (on && !halted ? 'live' : 'off')} />
            <b>AI 交易 · {title}</b>
            <em className={'env-badge ' + (status?.env ?? env)}>{status?.envLabel ?? (env === 'testnet' ? '模拟盘' : '实盘')}</em>
          </div>
          <div className="ai-top-actions">
            {on ? (
              <>
                <button className="btn ai-btn-stop" disabled={busy !== ''} onClick={() => void toggle(false)}>
                  {busy === 'toggle' ? '停止中…' : '停止 AI 交易'}
                </button>
                <button className="btn ai-btn-ghost" disabled={busy !== '' || halted} onClick={() => void decideNow()}>
                  {busy === 'decide' ? '决策中…' : '立即决策一次'}
                </button>
                <button className="btn ai-btn-ghost" disabled={busy !== ''} onClick={() => void halt(true)}>
                  {busy === 'halt' ? '…' : '急停'}
                </button>
              </>
            ) : (
              <button
                className="btn ai-btn-start"
                disabled={busy !== '' || !canEdit || !readyToRun}
                title={readyToRun ? '开始按这条策略下单' : whyNotReady}
                onClick={() => void toggle(true)}
              >
                {busy === 'toggle' ? '启动中…' : '开始 AI 交易'}
              </button>
            )}
          </div>
        </div>

        <div className="ai-facts">
          <span>今日决策 <b className="num">{counts.decisions}</b></span>
          <span>下单 <b className="num">{counts.orders}</b></span>
          <span>闸门拦下 <b className="num">{counts.refusals}</b></span>
          <span>出错 <b className="num">{counts.errors}</b></span>
          <span>当日亏损 <b className="num">{status ? status.dayLossPct.toFixed(2) : '0.00'}%</b>
            <em className="dim"> / 上限 {form?.maxDailyLossPct ?? '—'}%</em>
          </span>
          <span>上次决策 <b>{agoStr(status?.lastDecisionAt ?? 0)}</b></span>
        </div>

        {halted && (
          <div className="warn-box ai-halt">
            <b>熔断中：</b>{status?.haltReason}（到 {timeStr(status?.haltUntil ?? 0)} 自动解除）
          </div>
        )}
        {!on && !readyToRun && (
          <div className="ai-hint-line" style={{ color: 'var(--warn)' }}>
            还不能开始：{whyNotReady}
          </div>
        )}
        {!liveTrading && (
          <div className="warn-box ai-halt">
            <b>服务端的下单开关是关的。</b>闸门放行也发不出单 —— 到设置页打开「下单开关」，AI 才能真正下单。
          </div>
        )}
        {on && status && !status.skip && (
          <div className="ai-hint-line">
            下一次检查在 {timeStr(status.nextTickAt)}；每个合约隔 {form?.cooldownMin ?? '—'} 分钟看一次，同一时刻只做一个合约。
          </div>
        )}
        {on && status?.skip ? <div className="ai-hint-line">这一轮没做：{status.skip}</div> : null}
        {/* 整轮失败（拿不到材料、模型 403、交易员没回）不会产生决策记录，
            所以必须在这里说一句，否则页面上看不出「它试过、但没成」 */}
        {status?.lastError ? (
          <div className="ai-hint-line" style={{ color: 'var(--down)' }}>上一轮出错：{status.lastError}</div>
        ) : null}
      </div>

      <div className="ai-grid">
        {/* ---------- 左：策略 ---------- */}
        <div className="panel ai-form">
          <div className="panel-head">
            <span className="panel-title">策略</span>
            <span className="dim" style={{ fontSize: 11 }}>{canEdit ? '' : '只读：改策略只认本机'}</span>
          </div>
          <div className="panel-foot">
            {/*
              这里原来是"合约池（逗号分隔）"一个输入框。

              现在不让人填了：策略是在某一个币种上训练、回测、判定达标的，
              换一个币跑，那条"样本外期望为正"的结论就没有任何依据。
              所以"选策略"和"决定在哪个币上跑"是同一个动作，合成一格。
            */}
            <div className="field">
              <label>策略（决定用哪个币、什么周期）</label>
              <select
                className="select"
                value={form?.strategyId ?? ''}
                disabled={!canEdit || on}
                onChange={(e) => patch({ strategyId: e.target.value })}
              >
                <option value="">— 选一条过了回测的策略 —</option>
                {(payload?.strategies ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.contract} {s.interval}
                    {s.lastRun ? (s.lastRun.passed ? ' · 已达标' : ' · 未达标') : ' · 没跑过回测'}
                  </option>
                ))}
              </select>
              {!payload?.strategies.length && (
                <div className="hint" style={{ color: 'var(--warn)' }}>
                  策略库里还是空的。到「策略」页编一条、跑回测到达标，再回来选
                </div>
              )}
            </div>

            {/*
              合约池。策略不再绑死币种，所以这一格重新开放。
              但换币意味着"回测是在另一个品种上做的"——下面那块会把两个币并排显示。
            */}
            <div className="field">
              <label>合约池（这只策略要跑在哪个币上）</label>
              <input
                className="input"
                value={(form?.contracts ?? []).join(', ')}
                disabled={!canEdit || on}
                placeholder="BTC_USDT"
                onChange={(e) => patch({ contracts: e.target.value.split(/[,，\s]+/).filter(Boolean).map((s) => s.toUpperCase()) })}
              />
              <div className="hint">改完合约要回「策略」页重跑一次回测，结论才对应得上</div>
            </div>

            {/* 选中的策略长什么样，摆在开关旁边 —— 开之前就该看见上次回测是过还是没过 */}
            {payload?.binding && (
              <div className={'quant-binding ' + (payload.binding.passed ? 'ok' : 'bad')}>
                <div className="quant-binding-head">
                  <b>{payload.binding.name}</b>
                  <span className="dim">{payload.binding.contract} · {payload.binding.interval}</span>
                </div>
                <div className="quant-binding-note">
                  {payload.binding.passed === null
                    ? '还没跑过回测，不能开'
                    : !payload.binding.enoughSample
                      ? '回测样本不够 30 笔，判定不可信，不能开'
                      : payload.binding.passed
                        ? '上次回测达标'
                        : '上次回测没过：' + (payload.binding.failed.join('、') || '原因不明')}
                </div>
                {/*
                  上次回测的币和现在要跑的币不一致时，明说。
                  这条提示是本轮改动里最要紧的一句：策略可以换币跑，但换币之后
                  "样本外期望 +0.3%" 这条结论就不再直接适用于新币了。
                */}
                {(() => {
                  const running = (form?.contracts ?? []).join(',');
                  const tested = payload.binding.contract;
                  const diff = running && running !== tested;
                  return (
                    <div className={'quant-binding-note ' + (diff ? 'warn' : 'dim')}>
                      {diff
                        ? '注意：回测是在 ' + tested + ' 上做的，现在要跑 ' + running + ' —— 换币之后那条结论不直接适用，建议先在新币上重跑一次'
                        : '回测合约 ' + tested + ' · 周期 ' + payload.binding.interval}
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="field">
              <label>周期</label>
              <div className="seg">
                {['5m', '15m', '30m', '1h', '4h'].map((tf) => (
                  <button key={tf} className={form?.interval === tf ? 'on' : ''} disabled={!canEdit}
                    onClick={() => patch({ interval: tf })}>{tf}</button>
                ))}
              </div>
            </div>

            {/*
              这里原来是「决策深度」（快速 / 标准 / 深度），控制那套七角色协议调几次模型。
              现在方向由策略决定，那条协议不参与实盘了 —— 留着会让人以为它还在起作用。
              调用成本改由策略类型决定：规则策略 0 次，提示词策略 1 次。
            */}
            <div className="field">
              <label>每轮模型调用</label>
              <div className="hint">
                {payload?.binding?.kind === 'prompt'
                  ? '1 次：把你的提示词和匿名化行情交给模型，它回方向。'
                  : '0 次：规则策略由条件算方向，不调用模型。'}
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>杠杆</label>
                <input className="input" type="number" min={1} max={50} value={form?.leverage ?? 10}
                  disabled={!canEdit} onChange={(e) => patch({ leverage: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>保证金模式</label>
                <div className="seg">
                  <button className={form?.marginMode !== 'cross' ? 'on' : ''} disabled={!canEdit}
                    onClick={() => patch({ marginMode: 'isolated' })}>逐仓</button>
                  <button className={form?.marginMode === 'cross' ? 'on' : ''} disabled={!canEdit}
                    onClick={() => patch({ marginMode: 'cross' })}>全仓</button>
                </div>
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>单笔风险（权益的 %）</label>
                <input className="input" type="number" step={0.1} min={0.05} max={5} value={form?.riskPct ?? 0.5}
                  disabled={!canEdit} onChange={(e) => patch({ riskPct: Number(e.target.value) })} />
                <div className="hint">张数由它反推：这一笔亏到止损，最多亏这么多</div>
              </div>
              <div className="field">
                <label>单笔保证金上限（%）</label>
                <input className="input" type="number" step={1} min={5} max={100} value={form?.maxMarginPct ?? 40}
                  disabled={!canEdit} onChange={(e) => patch({ maxMarginPct: Number(e.target.value) })} />
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>最多同时持仓</label>
                <input className="input" type="number" min={1} max={8} value={form?.maxPositions ?? 2}
                  disabled={!canEdit} onChange={(e) => patch({ maxPositions: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>日内亏损上限（%）</label>
                <input className="input" type="number" step={0.5} min={0.5} max={50} value={form?.maxDailyLossPct ?? 3}
                  disabled={!canEdit} onChange={(e) => patch({ maxDailyLossPct: Number(e.target.value) })} />
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>最小置信度</label>
                <input className="input" type="number" step={0.05} min={0.1} max={0.99} value={form?.minConfidence ?? 0.55}
                  disabled={!canEdit} onChange={(e) => patch({ minConfidence: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>最小盈亏比</label>
                <input className="input" type="number" step={0.1} min={0.5} max={10} value={form?.minRR ?? 1.5}
                  disabled={!canEdit} onChange={(e) => patch({ minRR: Number(e.target.value) })} />
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <label>冷却（分钟）</label>
                <input className="input" type="number" min={0} max={720} value={form?.cooldownMin ?? 15}
                  disabled={!canEdit} onChange={(e) => patch({ cooldownMin: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>止损下限（ATR 倍数）</label>
                <input className="input" type="number" step={0.1} min={0.2} max={6} value={form?.stopAtrMult ?? 0.8}
                  disabled={!canEdit} onChange={(e) => patch({ stopAtrMult: Number(e.target.value) })} />
              </div>
            </div>

            {env === 'live' && (
              <label className="ai-live-confirm">
                <input type="checkbox" checked={Boolean(form?.liveConfirmed)} disabled={!canEdit}
                  onChange={(e) => patch({ liveConfirmed: e.target.checked })} />
                <span>确认用<b>真钱</b>下单。切换环境会把这个勾清掉，回来要重新确认</span>
              </label>
            )}

            <div className="ai-form-foot">
              <button className="btn ai-btn-ghost" disabled={!canEdit || busy !== '' || !dirty} onClick={() => void save()}>
                {busy === 'save' ? '保存中…' : dirty ? '保存策略' : '没有改动'}
              </button>
              {payload?.ai.configured === false && (
                <div className="hint" style={{ color: 'var(--warn)' }}>还没配 AI 密钥（设置页 → AI）</div>
              )}
            </div>
          </div>
        </div>

        {/* ---------- 右：决策流 ---------- */}
        <div className="ai-feed">
          {records.length === 0 ? (
            <div className="panel">
              <div className="panel-head"><span className="panel-title">决策流</span></div>
              <div className="panel-foot">
                <div className="empty">
                  还没有决策。<br />
                  打开上面的开关之后，它每隔 {form?.cooldownMin ?? 15} 分钟挑一个合约跑一次；
                  也可以点「立即决策一次」先看一轮。
                </div>
              </div>
            </div>
          ) : records.map((r) => (
            <DecisionCard
              key={r.id}
              rec={r}
              priceRound={2}
              open={Boolean(openTurns[r.id])}
              onToggle={() => setOpenTurns((m) => ({ ...m, [r.id]: !m[r.id] }))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 一条决策。摆的顺序就是判断的顺序：方向 → 张数 → 闸门判定 → 回执 → 角色原话 */
function DecisionCard({ rec, priceRound, open, onToggle }: {
  rec: AiDecisionRecord;
  priceRound: number;
  open: boolean;
  onToggle: () => void;
}) {
  const p = rec.plan;
  const g = rec.gate;
  const actionLabel = p.action === 'long' ? '做多' : p.action === 'short' ? '做空' : '观望';
  const failed = g.checks.filter((c) => !c.ok);
  const passed = g.checks.filter((c) => c.ok);

  return (
    <div className={'panel ai-rec ' + (rec.exec.ok ? 'fired' : g.ok ? 'blocked' : 'refused')}>
      <div className="ai-rec-head">
        <span className="ai-rec-time num">{timeStr(rec.at)}</span>
        <b>{rec.contract}</b>
        <span className="dim">
          {rec.interval} · {rec.strategyKind === 'prompt' ? '提示词策略' : '规则策略'}
          {' · '}{rec.usage.calls} 次调用 · {(rec.ms / 1000).toFixed(1)}s
        </span>
        <span className={'ai-verdict ' + p.action}>{actionLabel}</span>
        <span className="ai-conf num">{Math.round(p.confidence * 100)}%</span>
      </div>

      <div className="ai-rec-prices num">
        <span>入场 {p.entryType === 'market' ? '市价' : (p.entry ? fmtPrice(p.entry, priceRound) : '—')}</span>
        <span>止损 {p.stop ? fmtPrice(p.stop, priceRound) : '—'}</span>
        <span>止盈 {p.target ? fmtPrice(p.target, priceRound) : '—'}</span>
        <span>盈亏比 {g.rr > 0 ? g.rr.toFixed(2) : '—'}</span>
        <span>持有 {p.horizonHours}h</span>
      </div>

      {g.ok && (
        /* 张数上面这行只给结论，两个夹逼值在下面的闸门判定里（风险侧 / 保证金侧各多少张），
           同一件事不在两处用不同的说法重复一遍 */
        <div className="ai-rec-size num">
          <span>张数 <b>{g.size}</b></span>
          <span>名义 {g.notional} USDT</span>
          <span>保证金 {g.margin} USDT</span>
          <span>止损位亏 <b>{g.riskUsd} USDT</b></span>
        </div>
      )}

      {failed.length > 0 && (
        <div className="ai-rec-refuse">
          {failed.map((c, i) => <div key={i}>· <b>{c.label}</b>：{c.detail}</div>)}
        </div>
      )}

      {passed.length > 0 && (
        <div className="ai-rec-pass">
          {passed.map((c, i) => <span key={i}>{c.label} {c.detail}</span>)}
        </div>
      )}

      {g.warnings.length > 0 && (
        <div className="ai-rec-warn">{g.warnings.map((w, i) => <div key={i}>注意：{w}</div>)}</div>
      )}

      <div className={'ai-rec-exec ' + (rec.exec.ok ? 'ok' : 'no')}>
        {rec.exec.ok
          ? '已下单 #' + rec.exec.order?.id + ' · ' + rec.exec.order?.status
            + ' · 成交 ' + fmtPrice(rec.exec.order?.fillPrice ?? 0, priceRound)
            + ' · ' + rec.exec.order?.size + ' 张'
          : '没有发单：' + (rec.exec.error || '闸门拦下')}
      </div>

      {p.reasoning ? <div className="ai-rec-why">{p.reasoning}</div> : null}

      <button className="link-btn ai-rec-toggle" onClick={onToggle}>
        {open ? '收起角色发言' : '展开 ' + rec.turns.length + ' 条角色发言'}
      </button>

      {open && (
        <div className="ai-turns">
          {rec.turns.map((t, i) => (
            <div key={i} className={'ai-turn ' + (t.ok ? '' : 'bad')}>
              <div className="ai-turn-head">
                <b>{t.label}</b>
                {!t.ok && <span className="dim">（这一步没成：{t.error}）</span>}
              </div>
              {t.text ? <div className="ai-turn-body">{t.text}</div> : null}
            </div>
          ))}
          {rec.plan.vetoes.length > 0 && (
            <div className="ai-turn">
              <div className="ai-turn-head"><b>采纳的风控否决点</b></div>
              <div className="ai-turn-body">{rec.plan.vetoes.map((v, i) => <div key={i}>· {v}</div>)}</div>
            </div>
          )}
          {p.riskNote ? (
            <div className="ai-turn">
              <div className="ai-turn-head"><b>最容易被什么推翻</b></div>
              <div className="ai-turn-body">{p.riskNote}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}