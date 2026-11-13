import { useCallback, useEffect, useRef, useState } from 'react';
import { jget, jsend } from '../lib/api.ts';
import type {
  QuantCatalog, QuantCondition, QuantSpec, QuantVerdict,
  QuantBacktestResult, QuantEvent, SavedStrategySummary, StrategyKind,
} from '../lib/api.ts';

interface Props {
  canRun: boolean;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
}

type Busy = '' | 'backtest';

const OPS: { id: QuantCondition['op']; label: string }[] = [
  { id: '>', label: '大于' },
  { id: '<', label: '小于' },
  { id: '>=', label: '不低于' },
  { id: '<=', label: '不高于' },
  { id: 'crossUp', label: '上穿' },
  { id: 'crossDown', label: '下穿' },
];

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '8h', '1d'];

/** 起点：用服务端给的兜底假设，第一次打开就有东西可点 */
function starterSpec(catalog: QuantCatalog | null): QuantSpec {
  const f = catalog?.fallback;
  return {
    name: '我的策略',
    side: f?.side ?? 'long',
    params: { ...(f?.params ?? { n: 20, atrPeriod: 14 }) },
    ranges: { ...(f?.ranges ?? { n: [10, 60, 10] }) },
    entry: f ? f.entry.map((c) => ({ ...c })) : [],
    stop: f?.stop ?? { kind: 'atr', value: 1.5 },
    target: f?.target ?? { kind: 'rr', value: 2 },
    maxPositions: 1,
  };
}

const NL = String.fromCharCode(10);

/**
 * 把一段 NDJSON 流读成事件数组。
 *
 * 抽成独立函数而不是写在组件里，是因为 fetch 的流读取有三个地方容易写错：
 * 半行要留着等下一块、最后一个换行可能没有、解码要带 stream 选项。
 * 这三处任何一个写错，事件就会时有时无 —— 而且只在网络分块刚好切开时才出现。
 */
async function readEvents(res: Response, onEvent: (e: QuantEvent) => void, signal: AbortSignal): Promise<void> {
  if (!res.body) throw new Error('响应里没有流');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let stopped = false;
  signal.addEventListener('abort', () => { stopped = true; }, { once: true });
  while (!stopped) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let cut = buf.indexOf(NL);
    while (cut >= 0) {
      const line = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 1);
      if (line) {
        try { onEvent(JSON.parse(line) as QuantEvent); } catch { /* 半行 */ }
      }
      cut = buf.indexOf(NL);
    }
  }
  // 流结束时最后一行可能没有换行
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail) as QuantEvent); } catch { /* 忽略 */ }
  }
}
export default function QuantDesk({ canRun, onToast }: Props) {
  const [catalog, setCatalog] = useState<QuantCatalog | null>(null);
  const [contract, setContract] = useState('BTC_USDT');
  const [tf, setTf] = useState('1h');
  const [capital, setCapital] = useState(1000);
  const [spec, setSpec] = useState<QuantSpec>(() => starterSpec(null));
  const [result, setResult] = useState<QuantBacktestResult | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  /** 当前在库里对应的那条策略（保存过之后才有 id） */
  const [savedId, setSavedId] = useState('');
  /** 策略库列表，「打开已有策略」用它 */
  const [library, setLibrary] = useState<SavedStrategySummary[]>([]);
  // 默认展开：页面上有策略时，"从这里打开来编辑"应该是第一眼就看见的东西，
  // 藏在一个按钮后面会让人以为这一页只能新建
  const [pickerOpen, setPickerOpen] = useState(true);
  /** 策略类型：规则 / 提示词 */
  const [kind, setKind] = useState<StrategyKind>('rule');
  /** 提示词策略的指令正文 */
  const [prompt, setPrompt] = useState('');
  /** 提示词回测的抽样：每几根问一次、最多问几次 */
  const [step, setStep] = useState(20);
  const [maxCalls, setMaxCalls] = useState(150);

  const [rounds, setRounds] = useState(3);
  const [researching, setResearching] = useState(false);
  const [events, setEvents] = useState<QuantEvent[]>([]);
  const [stage, setStage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  /** 拉策略库。保存完、删完都要刷一次 */
  const refreshLibrary = useCallback(async () => {
    try {
      const r = await jget<{ strategies: SavedStrategySummary[] }>('/api/quant/strategies');
      setLibrary(r.strategies);
    } catch { /* 拉不到就空着，不影响编辑 */ }
  }, []);

  /**
   * 新建：清空编辑器回到兜底起点。
   *
   * 不清 savedId 的话，下一次「保存」会覆盖上一条策略 —— 那是很难被发现的数据丢失。
   */
  const newStrategy = useCallback(async () => {
    setSpec(starterSpec(catalog));
    setSavedId('');
    setResult(null);
    setPickerOpen(false);
    onToast('ok', '新建了一条空策略', '改完条件随时可以存；要拿去下单得先跑一次回测并且达标');
  }, [catalog, onToast]);

  /** 打开已有策略：把它整份载入编辑器，再回测一次看现在还成不成立 */
  const loadStrategy = useCallback(async (id: string) => {
    const s = library.find((x) => x.id === id);
    if (!s) return;
    try {
      const full = await jget<{ strategy: SavedStrategySummary }>('/api/quant/strategies/' + id);
      if (full.strategy.spec) setSpec(full.strategy.spec);
      setKind(full.strategy.kind);
      setPrompt(full.strategy.prompt ?? '');
      setSavedId(id);
      setContract(s.contract);
      setTf(s.interval);
      setResult(null);
      setPickerOpen(false);
      onToast('ok', '已载入「' + s.name + '」', '规则改了之后上次的回测结论就不算数了，重新跑一次');
    } catch (e) {
      onToast('err', '载入失败', (e as Error).message);
    }
  }, [library, onToast]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    let alive = true;
    jget<QuantCatalog>('/api/quant/catalog')
      .then((c) => { if (alive) { setCatalog(c); setSpec((s) => (s.entry.length ? s : starterSpec(c))); } })
      .catch((e) => onToast('err', '读不到指标清单', (e as Error).message));
    return () => { alive = false; };
  }, [onToast]);

  const patch = useCallback((p: Partial<QuantSpec>) => setSpec((s) => ({ ...s, ...p })), []);

  const patchCondition = useCallback((idx: number, p: Partial<QuantCondition>) => {
    setSpec((s) => ({ ...s, entry: s.entry.map((c, i) => (i === idx ? { ...c, ...p } : c)) }));
  }, []);

  const addCondition = useCallback(() => {
    setSpec((s) => ({
      ...s,
      entry: [...s.entry, { left: { name: 'close' }, op: '>' as const, right: { name: 'close' } }].slice(0, 3),
    }));
  }, []);

  const removeCondition = useCallback((idx: number) => {
    setSpec((s) => ({ ...s, entry: s.entry.filter((_, i) => i !== idx) }));
  }, []);

  const setParam = useCallback((key: string, value: number) => {
    setSpec((s) => ({ ...s, params: { ...s.params, [key]: value } }));
  }, []);

  const setRange = useCallback((key: string, idx: 0 | 1 | 2, value: number) => {
    setSpec((s) => {
      const cur = s.ranges[key] ?? [value, value, 1];
      const next: [number, number, number] = [cur[0], cur[1], cur[2]];
      next[idx] = value;
      return { ...s, ranges: { ...s.ranges, [key]: next } };
    });
  }, []);

  const dropRange = useCallback((key: string) => {
    setSpec((s) => { const r = { ...s.ranges }; delete r[key]; return { ...s, ranges: r }; });
  }, []);

  const addParam = useCallback(() => {
    const name = window.prompt('参数名（例如 emaFast / rsiPeriod）：');
    if (name) setParam(name.trim(), 20);
  }, [setParam]);

  const runBacktest = useCallback(async () => {
    if (kind === 'rule' && spec.entry.length === 0) { onToast('err', '先加一条入场条件'); return; }
    if (kind === 'prompt' && !prompt.trim()) { onToast('err', '提示词是空的', '写一段要模型照着判断的指令'); return; }
    setBusy('backtest');
    try {
      // 提示词策略要问很多次模型，超时给足；规则策略几百毫秒就完
      const timeout = kind === 'prompt' ? 900_000 : 300_000;
      const r = await jsend<QuantBacktestResult>('POST', '/api/quant/backtest', {
        contract, interval: tf, capital, spec, kind, prompt, step, maxCalls,
      }, undefined, AbortSignal.timeout(timeout));
      setResult(r);
      onToast('ok',
        r.mode === 'search' ? '搜索完成' : r.mode === 'prompt' ? '提示词回测完成' : '回测完成',
        r.mode === 'search'
          ? r.candidates + ' 组候选'
          : (r.stats?.trades ?? 0) + ' 笔交易');
    } catch (e) {
      onToast('err', '回测失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [contract, tf, capital, spec, kind, prompt, step, maxCalls, onToast]);

  const startResearch = useCallback(async () => {
    if (!canRun) { onToast('err', '只有本机能跑研究'); return; }
    const ctl = new AbortController();
    abortRef.current = ctl;
    setResearching(true);
    setEvents([]);
    setStage('准备中');
    try {
      const res = await fetch('/api/quant/research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contract, interval: tf, capital, rounds }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await readEvents(res, (ev) => {
        setEvents((prev) => [...prev, ev]);
        if (ev.type === 'stage') setStage(ev.message);
        if (ev.type === 'done') setStage('跑完了');
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onToast('err', '研究中断', (e as Error).message);
    } finally {
      setResearching(false);
      abortRef.current = null;
    }
  }, [canRun, contract, tf, capital, rounds, onToast]);

  const stopResearch = useCallback(() => {
    abortRef.current?.abort();
    setResearching(false);
  }, []);

  /** 改名。只改名字，不碰规则，所以不清回测结论 */
  const renameCurrent = useCallback(async () => {
    if (!savedId) { onToast('err', '还没存进策略库', '先存一次再改名'); return; }
    const cur = library.find((s) => s.id === savedId);
    const name = window.prompt('新的名字：', cur?.name ?? '');
    if (!name || name.trim() === cur?.name) return;
    try {
      await jsend('POST', '/api/quant/strategies/' + savedId + '/rename', { name: name.trim() });
      await refreshLibrary();
      onToast('ok', '已改名', '回测结论不受影响 —— 只改了名字，没改规则');
    } catch (e) {
      onToast('err', '改名失败', (e as Error).message);
    }
  }, [savedId, library, refreshLibrary, onToast]);

  /**
   * 保存到策略库。
   *
   * 不要求先跑回测：先把手上的规则存下来，再决定什么时候测，是正常的工作方式。
   * 库里对没跑过的策略标「没跑过回测」，AI 交易那边会拦（passNull 不能开），
   * 所以"存得进去"和"能用它下单"是两件事，前者不该设门槛。
   *
   * 跑过回测的话顺手把结论记上去；没跑过就只存规则。
   */
  const saveToLibrary = useCallback(async () => {
    if (kind === 'rule' && spec.entry.length === 0) { onToast('err', '策略还没有入场条件'); return; }
    if (kind === 'prompt' && !prompt.trim()) { onToast('err', '提示词是空的'); return; }
    const name = window.prompt('给这条策略起个名字：', spec.name || '我的策略');
    if (!name) return;
    try {
      const saved = await jsend<{ ok: boolean; strategy: { id: string; name: string } }>(
        'POST', '/api/quant/strategies',
        { id: savedId || undefined, name, kind, contract, interval: tf, spec, prompt },
      );
      setSavedId(saved.strategy.id);
      // 有回测结果才记结论。没有就只存规则 —— 库里会显示「没跑过回测」
      if (result) {
        await jsend('POST', '/api/quant/strategies/' + saved.strategy.id + '/run', {
          contract, interval: tf, spec, kind, prompt, step, maxCalls,
        }, undefined, AbortSignal.timeout(900_000));
      }
      await refreshLibrary();
      onToast('ok', '已存进策略库',
        result
          ? '回 AI 交易页就能选到「' + saved.strategy.name + '」'
          : '还没跑回测，AI 交易那边会显示「没跑过」并拦住 —— 想用就先回来跑一次');
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    }
  }, [result, spec, kind, prompt, step, maxCalls, contract, tf, savedId, onToast, refreshLibrary]);

  const hypotheses = events.filter((e) => e.type === 'hypothesis');
  const roundResults = events.filter((e) => e.type === 'round');
  const doneEvent = events.find((e) => e.type === 'done');
  return (
    <div className="quant-desk">
      <div className="panel quant-top">
        <div className="quant-top-head">
          <div>
            <b className="quant-title">策略</b>
            <span className="quant-subtitle">
              {savedId ? '已存进策略库：改动后记得再存一次' : '编一条规则，随时可存；要拿去下单得先跑回测并达标'}
            </span>
          </div>
          <div className="quant-top-actions">
            <button
              className="btn quant-btn-ghost"
              disabled={library.length === 0}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {pickerOpen ? '收起' : '打开已有策略（' + library.length + '）'}
            </button>
            <button className="btn quant-btn-ghost" onClick={() => void newStrategy()}>新建策略</button>
          </div>
        </div>

        {/* 打开已有策略：列出来点一下就载入编辑器 */}
        {pickerOpen && (
          <div className="quant-picker">
            {library.length === 0 && <div className="empty">策略库还是空的，点「新建策略」开始</div>}
            {library.map((s) => (
              <button
                key={s.id}
                className="quant-picker-row"
                onClick={() => void loadStrategy(s.id)}
              >
                <b>{s.name}</b>
                <span className="dim">{s.contract} · {s.interval}</span>
                <span className={s.lastRun ? (s.lastRun.passed ? 'up' : 'down') : 'dim'}>
                  {s.lastRun
                    ? (s.lastRun.passed ? '已达标' : '未达标') + ' · ' + s.lastRun.trades + ' 笔'
                    : '没跑过回测'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="quant-top-row">
          <label className="quant-field">
            <span>合约</span>
            <input className="input" value={contract} onChange={(e) => setContract(e.target.value.toUpperCase())} />
          </label>
          <label className="quant-field">
            <span>周期</span>
            <select className="select" value={tf} onChange={(e) => setTf(e.target.value)}>
              {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="quant-field">
            <span>本金 USDT</span>
            <input className="input" type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} />
          </label>
          <label className="quant-field">
            <span>AI 最多跑几轮</span>
            <input className="input" type="number" min={1} max={catalog?.limits.maxRounds ?? 6}
              value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
          </label>
          <div className="quant-top-note">交易所每个周期只保留约 9000 根，回测会自动往前翻页拿满</div>
        </div>
      </div>

      <div className="quant-grid">
        <div className="panel quant-editor">
          <div className="panel-head">
            <span className="panel-title">策略</span>
            <div className="seg" title="规则策略用指标条件；提示词策略让模型读行情自己判断">
              <button className={kind === 'rule' ? 'on' : ''} onClick={() => setKind('rule')}>规则</button>
              <button className={kind === 'prompt' ? 'on' : ''} onClick={() => setKind('prompt')}>提示词</button>
            </div>
          </div>

          <div className="panel-foot">
            {kind === 'rule' ? (
            <>
            <div className="quant-section">
              <div className="quant-section-head">
                <b>入场条件</b>
                <span className="dim">全部成立才开仓，最多 3 条</span>
                <button className="link-btn" onClick={addCondition} disabled={spec.entry.length >= 3}>+ 加一条</button>
              </div>
              {spec.entry.length === 0 && <div className="empty">还没有条件。先加一条。</div>}
              {spec.entry.map((c, idx) => (
                <div className="quant-cond" key={idx}>
                  <select className="select" value={c.left.name} onChange={(e) => patchCondition(idx, { left: { name: e.target.value } })}>
                    {(catalog?.indicators ?? []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                  </select>
                  <select className="select" value={c.left.periodKey ?? 'period'} onChange={(e) => patchCondition(idx, { left: { ...c.left, periodKey: e.target.value } })}>
                    {Object.keys(spec.params).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <select className="select" value={c.op} onChange={(e) => patchCondition(idx, { op: e.target.value as QuantCondition['op'] })}>
                    {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <select className="select" value={c.rightParam ? 'c:' + c.rightParam : c.right.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('c:')) patchCondition(idx, { rightParam: v.slice(2) });
                      else patchCondition(idx, { rightParam: undefined, right: { name: v } });
                    }}>
                    {(catalog?.indicators ?? []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                    {Object.keys(spec.params).map((k) => <option key={'c:' + k} value={'c:' + k}>常数 {k}</option>)}
                  </select>
                  <div className="quant-shift">
                    <span className="dim">错开</span>
                    <input className="input" type="number" min={0} max={10} value={c.shift ?? 0}
                      title="左值往前挪几根。假突破这类形态靠它表达"
                      onChange={(e) => patchCondition(idx, { shift: Number(e.target.value) || 0 })} />
                  </div>
                  <button className="link-btn quant-del" onClick={() => removeCondition(idx)} title="删掉这条">×</button>
                </div>
              ))}
            </div>

            <div className="quant-section">
              <div className="quant-section-head">
                <b>参数</b>
                <span className="dim">上面是默认值；下面填了范围就按范围搜索</span>
                <button className="link-btn" onClick={addParam}>+ 加一个</button>
              </div>
              <table className="data-table quant-params">
                <thead><tr><th className="txt">参数</th><th>默认</th><th>最小</th><th>最大</th><th>步长</th><th /></tr></thead>
                <tbody>
                  {Object.keys(spec.params).map((k) => (
                    <tr key={k}>
                      <td className="txt">{k}</td>
                      <td><input className="input" type="number" value={spec.params[k] ?? 0} onChange={(e) => setParam(k, Number(e.target.value))} /></td>
                      {[0, 1, 2].map((i) => (
                        <td key={i}>
                          <input className="input" type="number" value={spec.ranges[k]?.[i as 0 | 1 | 2] ?? ''} placeholder="—"
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '') dropRange(k);
                              else setRange(k, i as 0 | 1 | 2, Number(v));
                            }} />
                        </td>
                      ))}
                      <td><button className="link-btn" title="去掉范围" onClick={() => dropRange(k)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="quant-section">
              <div className="quant-section-head"><b>离场</b></div>
              <div className="row2">
                <label className="quant-field">
                  <span>止损</span>
                  <div className="quant-inline">
                    <select className="select" value={spec.stop.kind} onChange={(e) => patch({ stop: { ...spec.stop, kind: e.target.value as 'atr' | 'pct' } })}>
                      <option value="atr">ATR 倍数</option>
                      <option value="pct">百分比</option>
                    </select>
                    <input className="input" type="number" step={0.1} value={spec.stop.value}
                      onChange={(e) => patch({ stop: { ...spec.stop, value: Number(e.target.value) } })} />
                  </div>
                </label>
                <label className="quant-field">
                  <span>止盈</span>
                  <div className="quant-inline">
                    <select className="select" value={spec.target.kind} onChange={(e) => patch({ target: { ...spec.target, kind: e.target.value as 'atr' | 'pct' | 'rr' } })}>
                      <option value="rr">盈亏比</option>
                      <option value="atr">ATR 倍数</option>
                      <option value="pct">百分比</option>
                    </select>
                    <input className="input" type="number" step={0.1} value={spec.target.value}
                      onChange={(e) => patch({ target: { ...spec.target, value: Number(e.target.value) } })} />
                  </div>
                </label>
              </div>
            </div>
            </>
            ) : (
            <div className="quant-section">
              <div className="quant-section-head">
                <b>提示词</b>
                <span className="dim">你写的指令会原样交给模型，它读行情后回 long / short / flat</span>
              </div>
              <textarea
                className="textarea quant-prompt"
                rows={10}
                value={prompt}
                placeholder={
                  '例如：\n' +
                  '你是一个顺势交易者。看最近 40 根的价格结构：\n' +
                  '- 如果价格在最近 20 根的高点附近且成交量放大，做多；\n' +
                  '- 如果连续三根收在区间下沿之下，做空；\n' +
                  '- 其他情况不做。\n' +
                  '不要看具体数字是多少，只看形态。'
                }
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="quant-prompt-hint">
                回测时行情会被匿名化（币种、日期全部抹掉，价格归一化到 100）。
                不这么做，模型会在记忆里「认出」某段行情，测出来的就不是策略，是它的记性。
              </div>

              <div className="row2" style={{ marginTop: 8 }}>
                <label className="quant-field">
                  <span>每几根问一次</span>
                  <input className="input" type="number" min={1} max={200} value={step}
                    onChange={(e) => setStep(Number(e.target.value) || 20)} />
                </label>
                <label className="quant-field">
                  <span>最多问几次</span>
                  <input className="input" type="number" min={10} max={600} value={maxCalls}
                    onChange={(e) => setMaxCalls(Number(e.target.value) || 150)} />
                </label>
              </div>
              <div className="quant-prompt-hint">
                预计调用 {maxCalls} 次模型。每次都要花钱，也都要时间 —— 先从小的试。
              </div>
            </div>
            )}

            <div className="quant-actions">
              <button className="btn quant-btn-primary" disabled={busy !== '' || researching} onClick={() => void runBacktest()}>
                {busy === 'backtest' ? '回测中…' : Object.keys(spec.ranges).length ? '搜索参数并回测' : '回测'}
              </button>
              <button className="btn quant-btn-ghost" disabled={!canRun || busy !== '' || researching} onClick={() => void startResearch()}>
                {researching ? '研究中…' : '让 AI 提假设'}
              </button>
              <button className="btn quant-btn-ghost" disabled={researching} onClick={() => void saveToLibrary()}>
                {savedId ? '更新到策略库' : '存进策略库'}
              </button>
              {savedId && (
                <button className="btn quant-btn-ghost" onClick={() => void renameCurrent()}>改名</button>
              )}
              {researching && <button className="btn quant-btn-ghost" onClick={stopResearch}>停下</button>}
            </div>
          </div>
        </div>

        <div className="quant-right">
          {/*
            右边一开始是空的。以前那块地方什么都不显示，人会以为页面坏了。
            这里补一句"下一步做什么"，并把三个动作写清楚 —— 编辑、回测、存库，
            顺序就是页面上从左到右、从上到下的顺序。
          */}
          {!result && events.length === 0 && (
            <div className="panel quant-empty">
              <div className="panel-head"><span className="panel-title">从这里开始</span></div>
              <div className="panel-foot">
                <div className="quant-steps">
                  <div className="quant-step">
                    <b>1 · 编</b>
                    <span>左边选指标、加条件、填参数。条件是「全部成立才开仓」，最多三条。</span>
                  </div>
                  <div className="quant-step">
                    <b>2 · 测</b>
                    <span>点「搜索参数并回测」。填了范围的会搜索，没填的按默认值跑一次。</span>
                  </div>
                  <div className="quant-step">
                    <b>3 · 存</b>
                    <span>随时可点「存进策略库」。要用它下单，得先跑回测并达标 —— AI 交易那边会拦住没达标的。</span>
                  </div>
                </div>
                <div className="quant-note" style={{ marginTop: 10 }}>
                  也可以点「让 AI 提假设」：模型读回测结果换着思路提规则，判定仍由代码算。
                </div>
              </div>
            </div>
          )}
          {result && <ResultPanel result={result} />}
          {(events.length > 0 || researching) && (
            <div className="panel quant-research">
              <div className="panel-head">
                <span className="panel-title">AI 研究</span>
                <span className="dim">{researching ? stage : doneEvent ? '完成' : '已停止'}</span>
              </div>
              <div className="panel-foot">
                {hypotheses.map((h, i) => {
                  if (h.type !== 'hypothesis') return null;
                  const found = roundResults.find((x) => x.type === 'round' && x.round === h.round);
                  const rr = found && found.type === 'round' ? found : null;
                  return (
                    <div className="quant-round" key={i}>
                      <div className="quant-round-head"><b>第 {h.round} 轮</b><span className="dim">{h.thesis}</span></div>
                      <div className="quant-round-cond">
                        {h.entry.map((c, j) => (
                          <span key={j} className="quant-chip">
                            {c.left} {OPS.find((o) => o.id === c.op)?.label ?? c.op} {c.right}
                            {c.shift ? '（错开 ' + c.shift + ' 根）' : ''}
                          </span>
                        ))}
                      </div>
                      {rr?.semanticIssues?.length ? (
                        <div className="quant-issue">
                          假设不成立，没跑回测：
                          {rr.semanticIssues.map((x, j) => <div key={j}>· {x.message}</div>)}
                        </div>
                      ) : rr ? (
                        <div className="quant-round-result">
                          候选 {rr.candidates} 组，样本够 {rr.enoughSample} 组
                          {rr.best && (
                            <>
                              {' · 样本外 '}
                              <b className={rr.best.blindExpectancyPct > 0 ? 'up' : 'down'}>{rr.best.blindExpectancyPct.toFixed(3)}%/笔</b>
                              {' · '}{rr.best.blindTrades} 笔 · 盈亏比 {rr.best.blindPayoff}{' · 回撤 '}{rr.best.blindMaxDrawdownPct.toFixed(1)}%
                            </>
                          )}
                          {rr.verdict && (
                            <span className={rr.verdict.passed ? 'up' : 'down'}>
                              {' '}— {rr.verdict.passed ? '达标' : '未通过 ' + rr.verdict.failed.map((f) => f.label).join('、')}
                            </span>
                          )}
                        </div>
                      ) : <div className="dim">回测中…</div>}
                    </div>
                  );
                })}
                {doneEvent && doneEvent.type === 'done' && <div className="quant-done">{doneEvent.verdict}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
/** 回测结果：先给判定，再给数字。判定不过的话，数字再好看也是噪音 */
function ResultPanel({ result }: { result: QuantBacktestResult }) {
  const v: QuantVerdict | null = result.verdict;
  const s = result.stats;
  const best = result.best;

  return (
    <div className="panel quant-result">
      <div className="panel-head">
        <span className="panel-title">回测结果</span>
        <span className="dim">{result.bars} 根 · {result.days} 天{result.gaps ? ' · 断档 ' + result.gaps : ''}</span>
      </div>
      <div className="panel-foot">
        {v && (
          <div className={'quant-verdict ' + (v.passed ? 'pass' : 'fail')}>
            <b>{v.passed ? '达标' : '未通过'}</b>
            {!v.passed && <span>：{v.failed.map((f) => f.label).join('、')}</span>}
          </div>
        )}

        {v && (
          <table className="data-table quant-checks">
            <thead><tr><th className="txt">判定项</th><th>实测</th><th>要求</th></tr></thead>
            <tbody>
              {v.checks.map((c) => (
                <tr key={c.key} title={c.why}>
                  <td className="txt">{c.pass ? '✓' : '✗'} {c.label}</td>
                  <td>{c.value}</td>
                  <td className="dim">{c.threshold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {s && (
          <>
            <div className="quant-stats">
              <div><span>交易笔数</span><b>{s.trades}</b></div>
              <div><span>胜率</span><b>{(s.winRate * 100).toFixed(1)}%</b></div>
              <div><span>盈亏比</span><b>{s.payoff.toFixed(2)}</b></div>
              <div><span>每笔期望</span><b className={s.expectancyPct > 0 ? 'up' : 'down'}>{s.expectancyPct.toFixed(3)}%</b></div>
              <div><span>总收益</span><b className={s.totalReturnPct > 0 ? 'up' : 'down'}>{s.totalReturnPct.toFixed(2)}%</b></div>
              <div><span>最大回撤</span><b>{s.maxDrawdownPct.toFixed(1)}%</b></div>
              <div><span>最长连亏</span><b>{s.maxLosingStreak}</b></div>
              <div><span>手续费</span><b>{s.totalFee.toFixed(2)}</b></div>
            </div>
            <div className="quant-note">
              盈亏比只作展示，不参与判定：胜率低时它再高也能亏钱。判定看的是每笔期望。
            </div>
          </>
        )}

        {result.mode === 'search' && (
          <div className="quant-search-sum">
            <div>候选 {result.candidates ?? 0} 组，其中样本量够的 {result.enoughSample ?? 0} 组</div>
            {best && (
              <div className="quant-best-params">
                最优参数：
                {Object.entries(best.params).map(([k, val]) => (
                  <span key={k} className="quant-chip">{k}={val}</span>
                ))}
              </div>
            )}
            {(result.enoughSample ?? 0) === 0 && (
              <div className="quant-issue">
                所有候选的样本外交易都不够 30 笔，这时候的胜率和盈亏比都是噪音，不给判定。
                换个更活跃的周期，或者放宽入场条件。
              </div>
            )}
          </div>
        )}

        {result.equity && result.equity.length > 1 && <EquityChart points={result.equity} />}
      </div>
    </div>
  );
}

/** 权益曲线。用 SVG 直接画：只有一条线，不值得为它引图表库 */
function EquityChart({ points }: { points: { t: number; v: number }[] }) {
  const w = 640;
  const h = 140;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * (h - 8) - 4;
  const d = points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  const first = points[0]!.v;
  const last = points[points.length - 1]!.v;
  const up = last >= first;

  return (
    <div className="quant-equity">
      <svg viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none">
        <line x1={0} y1={y(first)} x2={w} y2={y(first)} className="quant-base" />
        <path d={d} className={up ? 'quant-eq-up' : 'quant-eq-down'} fill="none" />
      </svg>
      <div className="quant-equity-meta">
        <span>权益 {first.toFixed(0)} → {last.toFixed(0)}</span>
        <span className="dim">最低 {min.toFixed(0)} / 最高 {max.toFixed(0)}</span>
      </div>
    </div>
  );
}
