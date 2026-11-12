import { useCallback, useEffect, useMemo, useState } from 'react';
import { jget, jsend } from '../lib/api.ts';
import type { Bar, ResearchAnalysis, ResearchDir, ResearchHealth, ResearchScan, Zone } from '../lib/api.ts';
import { fmtPct, fmtPrice } from '../lib/format.ts';
import ChartPane from './ChartPane.tsx';
import ResearchCards from './ResearchCards.tsx';
import ScanTable from './ScanTable.tsx';

interface Props {
  /** 只有本机能选数据目录（选目录等于让程序读硬盘） */
  canPick: boolean;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
}

type Busy = '' | 'dir' | 'analyze' | 'scan';

/**
 * 关键位研究台。
 *
 * 这是上游项目（Detect_support_and_resistance_levels）那套用法的完整形态：
 * 选一个本地 parquet/csv 目录 → 单品种深度分析（双概率 + 多周期共振 + 分位档）
 * → 全市场批量扫描，按有效概率排序找出值得看的标的。
 *
 * 和交易台共用同一个引擎（Python sidecar 里的上游 V3Fusion），所以两边算出来的
 * 关键位一定一致；区别只在于交易台看的是交易所实时行情，这里看的是你本地的历史数据。
 */
export default function ResearchDesk({ canPick, onToast }: Props) {
  const [health, setHealth] = useState<ResearchHealth | null>(null);
  const [dir, setDir] = useState<ResearchDir | null>(null);
  const [dirInput, setDirInput] = useState('');
  const [symbol, setSymbol] = useState('');
  const [tf, setTf] = useState('D1');
  const [windowBars, setWindowBars] = useState(40);
  const [nZones, setNZones] = useState(3);
  const [direction, setDirection] = useState<'long' | 'short' | 'both'>('long');
  const [mtf, setMtf] = useState(true);
  const [analysis, setAnalysis] = useState<ResearchAnalysis | null>(null);
  const [scan, setScan] = useState<ResearchScan | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  const [err, setErr] = useState('');

  const instruments = dir?.instruments ?? [];
  const tfs = useMemo(
    () => instruments.find((i) => i.symbol === symbol)?.timeframes ?? [],
    [instruments, symbol],
  );

  /** 引擎状态：决定「概率列」显不显示，以及页面顶上那句提示 */
  const loadHealth = useCallback(async () => {
    try {
      const h = await jget<ResearchHealth>('/api/research/health');
      setHealth(h);
    } catch (e) {
      setHealth({ ok: false, detail: (e as Error).message });
    }
  }, []);

  /** 读记住的数据目录（上次选过的，重启后还在） */
  const loadDir = useCallback(async () => {
    try {
      const d = await jget<ResearchDir>('/api/research/dir');
      setDir(d);
      setDirInput(d.dir);
      if (d.instruments.length > 0) {
        setSymbol((cur) => (d.instruments.some((i) => i.symbol === cur) ? cur : d.instruments[0]!.symbol));
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadHealth(); void loadDir(); }, [loadHealth, loadDir]);

  /** 品种变了、周期不在它名下，就退回它有的第一个周期 */
  useEffect(() => {
    if (tfs.length > 0 && !tfs.includes(tf)) setTf(tfs[0]!);
  }, [tfs, tf]);

  const pickDir = useCallback(async (raw: string) => {
    if (!raw.trim()) return;
    setBusy('dir'); setErr('');
    try {
      const r = await jsend<ResearchDir & { ok: boolean }>('POST', '/api/research/dir', { dir: raw.trim() });
      setDir({ dir: r.dir, exists: true, count: r.count, instruments: r.instruments, files: r.files, warning: r.warning });
      setDirInput(r.dir);
      setScan(null); setAnalysis(null);
      if (r.instruments.length > 0) {
        const first = r.instruments[0]!.symbol;
        setSymbol(first);
        setTf(r.instruments[0]!.timeframes[0] ?? 'D1');
        onToast('ok', '数据目录已载入', r.count + ' 个品种 · ' + r.files + ' 个文件');
      } else {
        onToast('err', '这个目录里没有认得的 K 线文件', r.warning ?? '文件名要写成「品种_周期.parquet」，列要有 time/open/high/low/close/volume');
      }
    } catch (e) {
      setErr((e as Error).message);
      onToast('err', '选目录失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [onToast]);

  const analyze = useCallback(async (sym?: string, tfOverride?: string) => {
    const s = (sym ?? symbol).trim();
    if (!s) { onToast('err', '先选一个品种'); return; }
    const useTf = tfOverride ?? tf;
    setBusy('analyze'); setErr('');
    try {
      const a = await jget<ResearchAnalysis>(
        '/api/research/analyze?symbol=' + encodeURIComponent(s)
        + '&tf=' + encodeURIComponent(useTf)
        + '&window=' + windowBars
        + '&n_zones=' + nZones
        + '&direction=' + direction
        + '&mtf=' + (mtf ? 'true' : 'false')
        + '&n_bars=400',
        { signal: AbortSignal.timeout(120_000) },
      );
      setAnalysis(a);
      setSymbol(a.symbol);
      setTf(a.tf);
    } catch (e) {
      setErr((e as Error).message);
      onToast('err', '分析失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [symbol, tf, windowBars, nZones, direction, mtf, onToast]);

  const runScan = useCallback(async () => {
    setBusy('scan'); setErr('');
    try {
      const r = await jget<ResearchScan>(
        '/api/research/scan?tf=' + encodeURIComponent(tf)
        + '&window=' + windowBars
        + '&n_zones=' + nZones
        + '&direction=' + direction,
        { signal: AbortSignal.timeout(600_000) },
      );
      setScan(r);
      onToast('ok', '扫描完成', r.summary.analyzed + ' 个品种，按有效概率排序');
    } catch (e) {
      setErr((e as Error).message);
      onToast('err', '扫描失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [tf, windowBars, nZones, direction, onToast]);

  /**
   * 载入目录之后自动分析；换品种、换周期也跟着算一遍。
   *
   * 上游是「点了才分析」，但那样一进页面是一张空表，用户不知道下一步该点哪儿；
   * 换个品种还得再点一次就更别扭 —— 本地算一次只要几十毫秒，没必要让人等按钮。
   * 「每侧档位 / 方向 / 共振」这些改了不会自动重算，那是「分析单品种」按钮的事：
   * 这几项重算更贵，也更容易让人以为结果自己变了。
   */
  useEffect(() => {
    if (!dir?.count || !symbol) return;
    if (analysis && analysis.symbol === symbol && analysis.tf === tf) return;
    void analyze(symbol, tf);
  }, [dir, symbol, tf, analysis, analyze]);

  /** 表里点一行 → 单品种分析 */
  const pickRow = useCallback((sym: string) => {
    setSymbol(sym);
    void analyze(sym, tf);
  }, [analyze, tf]);

  // 图表要的是行式 K 线；引擎给的是列式（省流量、也省一次转换）
  const chartBars: Bar[] = useMemo(() => {
    const k = analysis?.kline;
    if (!k) return [];
    const out: Bar[] = [];
    for (let i = 0; i < k.time.length; i++) {
      out.push({
        time: k.time[i]!, open: k.open[i]!, high: k.high[i]!,
        low: k.low[i]!, close: k.close[i]!, volume: k.volume[i]!,
      });
    }
    return out;
  }, [analysis]);

  const priceRoundOf = useCallback((sym: string): number => {
    const px = sym === analysis?.symbol ? analysis.current_price : (scan?.rows.find((r) => r.symbol === sym)?.current_price ?? 0);
    if (!(px > 0)) return 0.01;
    return px >= 1000 ? 0.1 : px >= 1 ? 0.01 : 0.0001;
  }, [analysis, scan]);

  const engineDown = health !== null && !health.ok;

  return (
    <section className="research">
      <div className="rsh-head">
        <div>
          <h2>关键位研究台</h2>
          <p>读本地 K 线，算支撑阻力带和它的双概率。不看盘、不下单。</p>
        </div>
        <div className={`rsh-engine ${health ? (health.ok ? 'on' : 'off') : ''}`}>
          <i className="status-dot" />
          {health === null ? '引擎检查中…'
            : health.ok
              ? '引擎 ' + (health.engine ?? 'v3fusion') + ' · Python ' + (health.python ?? '') +
                (health.probReady ? ' · 概率模型已加载' : ' · 概率模型缺失') +
                (health.calibrated ? ' · 校准表已加载' : '')
              : '引擎未就绪：' + (health.detail ?? '未知原因')}
        </div>
      </div>

      {engineDown && (
        <div className="rsh-warn">
          关键位引擎（Python sidecar）没有启动，这一页算不出东西。常见原因：仓库里缺 <code>sidecar/.venv</code>
          （跑一次 <code>python -m venv sidecar/.venv &amp;&amp; sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt</code>）、
          或者安装版少了 sidecar 目录。交易台的实时行情不受影响，但档位也会跟着停 —— 那是同一个引擎。
        </div>
      )}

      <div className="rsh-dirbar">
        <label>本地数据目录</label>
        <input
          value={dirInput}
          onChange={(e) => setDirInput(e.target.value)}
          placeholder="例如 D:\MT5_K线数据 或者 D:\A股_K线数据\parquet\stocks"
          spellCheck={false}
        />
        <button
          className="btn"
          disabled={!canPick || busy === 'dir'}
          title={canPick ? '记住这个目录（只在本机可改）' : '只有本机打开页面时才能选目录'}
          onClick={() => void pickDir(dirInput)}
        >
          {busy === 'dir' ? '载入中…' : '载入这个目录'}
        </button>
        <span className="dim">
          {dir?.exists && dir.count > 0 ? `${dir.count} 个品种 · ${dir.files} 个文件` : '还没载入'}
        </span>
      </div>
      {dir?.warning && <div className="rsh-warn">{dir.warning}</div>}

      <div className="rsh-controls">
        <label>
          品种
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {instruments.length === 0 && <option value="">— 先载入目录 —</option>}
            {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
          </select>
        </label>
        <label>
          周期
          <select value={tf} onChange={(e) => setTf(e.target.value)}>
            {tfs.length === 0 && <option value={tf}>{tf}</option>}
            {tfs.map((t) => <option key={t} value={t}>{dir?.tfLabels?.[t] ?? t}</option>)}
          </select>
        </label>
        <label>
          K 线
          <select value={windowBars} onChange={(e) => setWindowBars(Number(e.target.value))}>
            {[20, 40, 60, 90, 120, 250].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          每侧档位
          <select value={nZones} onChange={(e) => setNZones(Number(e.target.value))}>
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          方向
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'long' | 'short' | 'both')}>
            <option value="long">只做多</option>
            <option value="short">只做空</option>
            <option value="both">多空都做</option>
          </select>
        </label>
        <label className="rsh-check" title="拿同品种的其他周期各算一遍，标出共振">
          <input type="checkbox" checked={mtf} onChange={(e) => setMtf(e.target.checked)} />
          多周期共振
        </label>
        <button className="btn primary" disabled={!symbol || busy === 'analyze'} onClick={() => void analyze()}>
          {busy === 'analyze' ? '分析中…' : '分析单品种'}
        </button>
        <button className="btn" disabled={!dir?.count || busy === 'scan'} onClick={() => void runScan()}>
          {busy === 'scan' ? '扫描中…' : '分析全部'}
        </button>
      </div>

      {err && <div className="rsh-err">{err}</div>}

      {analysis && (
        <>
          <ResearchCards a={analysis} priceRound={priceRoundOf(analysis.symbol)} />
          {analysis.engine.adjust_warning && <div className="rsh-warn">{analysis.engine.adjust_warning}</div>}

          <div className="rsh-chart">
            <ChartPane
              research
              contract={analysis.symbol}
              interval={analysis.tf}
              bars={chartBars}
              zones={analysis.zones}
              positions={[]}
              orders={[]}
              multiplier={0}
              markPrice={analysis.current_price}
              priceRound={priceRoundOf(analysis.symbol)}
              resetKey={analysis.symbol + ':' + analysis.tf}
              loading={false}
              onIntervalChange={() => {}}
              onManualLevels={() => {}}
              canClose={false}
              onClosePosition={() => {}}
              onPickPrice={() => {}}
              hasPosition={false}
            />
          </div>

          <div className="rsh-table-card">
            <div className="rsh-table-title">支撑 / 阻力带</div>
            <div className="rsh-table-scroll">
              <table className="rsh-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>中心价</th>
                    <th>价格带</th>
                    <th>带宽</th>
                    <th>距现价</th>
                    <th title="未来若干根内价格走到这个位的概率">触及概率</th>
                    <th title="走到后反弹而非跌穿的概率">守住概率</th>
                    <th title="触及 × 守住">有效概率</th>
                    <th>被测试</th>
                    <th title="这条位的强度在历史分位里属于第几档">档位</th>
                    <th title="成交量剖面看「价格容易在这里停」的倾向，不参与排序">停滞</th>
                    <th title="这条位同时在哪些周期上成立">共振</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.zones.map((z) => <ZoneRow key={z.zone_type + z.center} z={z} round={priceRoundOf(analysis.symbol)} />)}
                  {analysis.zones.length === 0 && (
                    <tr><td colSpan={12} className="dim" style={{ textAlign: 'center', padding: 16 }}>
                      距离带（0.5~5 ATR）内没有合格的位。换周期、换方向，或者把「每侧档位」调大一点
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {analysis.engine.prob_ready === false && (
              <div className="rsh-errors">概率模型没加载，所以「触及/守住/有效概率」是空的；位置和强度照常算。</div>
            )}
          </div>

          <div className="rsh-caveat">
            <b>这些数字该怎么用</b>
            <p>{analysis.summary.caveat}</p>
            <p>
              分位档（Q1~Q5）和「该档历史守住率」来自上游在 A 股日线上的标定样本，
              搬到加密/期货上只能当参照，不是这里的胜率。
            </p>
          </div>
        </>
      )}

      <div className="rsh-table-title" style={{ marginTop: 18 }}>全市场扫描</div>
      <ScanTable scan={scan} loading={busy === 'scan'} priceRoundOf={priceRoundOf} onPick={pickRow} />

      <div className="rsh-foot">
        以上内容由算法基于历史行情自动生成，仅供技术分析参考，不构成任何投资建议。
      </div>
    </section>
  );
}

function ZoneRow({ z, round }: { z: Zone; round: number }) {
  const pct = (v: number | null) => (v === null ? '—' : Math.round(v * 100) + '%');
  const dist = z.distance_pct >= 0 ? '+' + z.distance_pct.toFixed(2) + '%' : z.distance_pct.toFixed(2) + '%';
  return (
    <tr>
      <td className={z.zone_type === 'support' ? 's' : 'r'}>{z.zone_type === 'support' ? '支撑' : '阻力'}</td>
      <td className="num strong">{fmtPrice(z.center, round)}</td>
      <td className="num dim">{fmtPrice(z.low, round)} ~ {fmtPrice(z.high, round)}</td>
      <td className="num">{z.width_atr.toFixed(2)} ATR</td>
      <td className="num">{dist} <span className="dim">({fmtPct(z.distance_atr, 2)} ATR)</span></td>
      <td className="num">{pct(z.p_touch)}</td>
      <td className="num">{pct(z.p_hold)}</td>
      <td className="num strong">{pct(z.p_effective)}</td>
      <td className="num">{z.n_events}</td>
      <td className="num" title={z.bucket_hold_rate !== null ? `该档样本外实测守住率 ${(z.bucket_hold_rate * 100).toFixed(1)}%（A 股日线样本）` : undefined}>
        {z.bucket ?? '—'}
      </td>
      <td className="num">{z.p_stall.toFixed(2)}</td>
      <td className="num">{z.tf_count > 1 ? z.tfs : '—'}</td>
    </tr>
  );
}
