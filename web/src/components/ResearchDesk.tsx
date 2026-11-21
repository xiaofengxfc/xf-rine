import { useCallback, useEffect, useMemo, useState } from 'react';
import { jget } from '../lib/api.ts';
import type { Bar, LocalDirInfo, ResearchAnalysis, ResearchHealth, ResearchScan, Zone } from '../lib/api.ts';
import { fmtPct, fmtPrice, guessPriceRound } from '../lib/format.ts';
import ChartPane from './ChartPane.tsx';
import ResearchCards from './ResearchCards.tsx';
import ScanTable from './ScanTable.tsx';

interface Props {
  /** 只有本机能选数据目录（选目录等于让程序读硬盘） */
  canPick: boolean;
  /** 两个台共用的数据目录（状态在 App 那一层） */
  dir: LocalDirInfo | null;
  /** 共用的品种 / 周期：研究台换一个，切回日内台的本地图也是它 */
  symbol: string;
  tf: string;
  onSymbol: (s: string) => void;
  onTf: (tf: string) => void;
  /** 换目录。失败时 App 已经弹过提示，这里只负责转圈 */
  onPickDir: (dir: string) => Promise<LocalDirInfo | null>;
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
 * 和交易台共用同一个引擎（Python sidecar 里的上游 V3Fusion），也共用同一份数据目录和
 * 同一对品种/周期 —— 所以两边算出来的关键位一定一致，切来切去看到的也是同一个标的。
 * 区别只在于交易台看的是交易所实时行情，这里看的是你本地的历史数据。
 */
export default function ResearchDesk({
  canPick, dir, symbol, tf, onSymbol, onTf, onPickDir, onToast,
}: Props) {
  const [health, setHealth] = useState<ResearchHealth | null>(null);
  const [dirInput, setDirInput] = useState(dir?.dir ?? '');
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
  /**
   * 目录、品种、周期三样都齐了才算「能算」。
   *
   * 少了这一条，页面一进来会先拿默认的 D1 去撞一个只有 H1 的品种，闪一条
   * 「找不到数据文件 …D1.parquet」，然后才被兜底成 H1 —— 明明是正常加载，看着像坏了。
   */
  const ready = instruments.length > 0 && Boolean(symbol) && tfs.includes(tf);
  const tfLabel = dir?.tfLabels?.[tf] ?? tf;

  // 目录换了（研究台或日内台任意一边），输入框跟着走
  useEffect(() => { setDirInput(dir?.dir ?? ''); }, [dir?.dir]);

  // 换目录 = 之前那批结果作废，别拿旧目录的数字对着新目录的品种
  useEffect(() => { setAnalysis(null); setScan(null); setErr(''); }, [dir?.dir]);

  /** 引擎状态：决定「概率列」显不显示，以及页面顶上那句话 */
  const loadHealth = useCallback(async () => {
    try {
      setHealth(await jget<ResearchHealth>('/api/research/health'));
    } catch (e) {
      setHealth({ ok: false, detail: (e as Error).message });
    }
  }, []);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const pickDir = useCallback(async (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setBusy('dir'); setErr('');
    try { await onPickDir(v); } finally { setBusy(''); }
  }, [onPickDir]);

  const analyze = useCallback(async (sym?: string, tfOverride?: string) => {
    const s = (sym ?? symbol).trim();
    const useTf = tfOverride ?? tf;
    if (!s) { onToast('err', '先选一个品种'); return; }
    // 周期还没兜底成这个品种真有的那个：不动，等下一次渲染
    if (instruments.find((i) => i.symbol === s)?.timeframes.includes(useTf) !== true) return;
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
      // 不拿 a.tf 回填共用的周期：引擎可能把 H1 写成 h1，回填进去反而不在下拉选项里，
      // 「能不能算」会当场变成 false。图上用哪个周期由 analysis 自己决定。
      setAnalysis(a);
    } catch (e) {
      setErr((e as Error).message);
      onToast('err', '分析失败', (e as Error).message);
    } finally { setBusy(''); }
  }, [symbol, tf, instruments, windowBars, nZones, direction, mtf, onToast]);

  const runScan = useCallback(async () => {
    if (!ready) return;
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
  }, [ready, tf, windowBars, nZones, direction, onToast]);

  /**
   * 载入目录之后自动分析；换品种、换周期也跟着算一遍。
   *
   * 上游是「点了才分析」，但那样一进页面是一张空表，用户不知道下一步该点哪儿；
   * 换个品种还得再点一次就更别扭 —— 本地算一次只要几十毫秒，没必要让人等按钮。
   * 「每侧档位 / 方向 / 共振」这些改了不会自动重算，那是「分析单品种」按钮的事：
   * 这几项重算更贵，也更容易让人以为结果自己变了。
   */
  useEffect(() => {
    if (!ready) return;
    if (analysis && analysis.symbol === symbol && analysis.tf === tf) return;
    void analyze(symbol, tf);
  }, [ready, symbol, tf, analysis, analyze]);

  /** 表里点一行 → 单品种分析，同时把共用的品种也切过去 */
  const pickRow = useCallback((sym: string) => {
    onSymbol(sym);
    void analyze(sym, tf);
  }, [analyze, onSymbol, tf]);

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

  // 和日内台的本地图用同一个估算（见 lib/format.ts）：同一个品种，两边的小数位数得一样
  const priceRoundOf = useCallback((sym: string): number => {
    const px = sym === analysis?.symbol ? analysis.current_price : (scan?.rows.find((r) => r.symbol === sym)?.current_price ?? 0);
    return guessPriceRound(px);
  }, [analysis, scan]);

  const engineDown = health !== null && !health.ok;
  const engineText = health === null ? '引擎检查中…'
    : health.ok
      ? '引擎 ' + (health.engine ?? 'v3fusion') + ' · Python ' + (health.python ?? '')
        + (health.probReady ? ' · 概率模型已加载' : ' · 概率模型缺失')
        + (health.calibrated ? ' · 校准表已加载' : '')
      : '引擎未就绪：' + (health.detail ?? '未知原因');

  return (
    <section className="research">
      <div className="page-head">
        <div>
          <h2>关键位研究台</h2>
          <p>读本地 K 线，算支撑阻力带和它的双概率。不看盘、不下单。</p>
        </div>
        <span className={'pill engine ' + (health ? (health.ok ? 'on' : 'off') : '')}>
          <i className="status-dot" />
          {engineText}
        </span>
      </div>

      {engineDown && (
        <p className="note warn">
          关键位引擎（Python sidecar）没有启动，这一页算不出东西。常见原因：仓库里缺 <code>sidecar/.venv</code>
          （跑一次 <code>python -m venv sidecar/.venv &amp;&amp; sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt</code>）、
          或者安装版少了 sidecar 目录。日内台的实时行情不受影响，但档位也会跟着停 —— 那是同一个引擎。
        </p>
      )}

      {/* 本地目录和分析参数仅供研究台使用。 */}
      <div className="panel">
        <div className="panel-head">
          <h3>本地数据</h3>
          <span className="dim">
            {dir?.dir
              ? (instruments.length > 0
                ? `${dir.count || instruments.length} 个品种 · ${dir.files} 个文件`
                : '目录里没有认得的 K 线文件')
              : '还没选目录'}
            {busy === 'dir' ? ' · 载入中…' : ''}
          </span>
        </div>
        <div className="toolbar">
          <label className="field-inline grow">
            目录
            <input
              className="input sm"
              value={dirInput}
              // 手机上换不了目录（那个接口只认本机）：框锁住，别让人对着一个点了没反应的输入框打字
              disabled={!canPick}
              onChange={(e) => setDirInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void pickDir(dirInput); }}
              placeholder={canPick ? 'D:/MT5_K线数据 或 D:/A股_K线数据/parquet/stocks' : '只能在电脑上换目录'}
              spellCheck={false}
            />
          </label>
          <button
            className="btn xs ghost"
            disabled={!canPick || busy === 'dir' || !dirInput.trim()}
            title={canPick ? '记住这个目录（只在本机可改）' : '只有本机打开页面时才能选目录'}
            onClick={() => void pickDir(dirInput)}
          >
            {busy === 'dir' ? '载入中…' : '载入这个目录'}
          </button>
        </div>

        {!dir?.dir && (
          <p className="note">
            还没有数据目录。在电脑上选一个放着「品种_周期.parquet」的文件夹 ——
            研究台和日内台的本地图用的是同一份。
          </p>
        )}
        {dir?.warning && <p className="note warn">{dir.warning}</p>}

        <div className="toolbar">
          <label className="field-inline">
            品种
            <select className="select sm" value={symbol} onChange={(e) => onSymbol(e.target.value)}>
              {instruments.length === 0 && <option value="">— 先载入目录 —</option>}
              {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
            </select>
          </label>
          <label className="field-inline">
            周期
            <select className="select sm" value={tf} onChange={(e) => onTf(e.target.value)}>
              {tfs.length === 0 && <option value={tf}>{tfLabel}</option>}
              {tfs.map((t) => <option key={t} value={t}>{dir?.tfLabels?.[t] ?? t}</option>)}
            </select>
          </label>
          <label className="field-inline">
            K 线
            <select className="select sm" value={windowBars} onChange={(e) => setWindowBars(Number(e.target.value))}>
              {[20, 40, 60, 90, 120, 250].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field-inline">
            每侧档位
            <select className="select sm" value={nZones} onChange={(e) => setNZones(Number(e.target.value))}>
              {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field-inline">
            方向
            <select className="select sm" value={direction} onChange={(e) => setDirection(e.target.value as 'long' | 'short' | 'both')}>
              <option value="long">只做多</option>
              <option value="short">只做空</option>
              <option value="both">多空都做</option>
            </select>
          </label>
          <label className="field-inline check" title="拿同品种的其他周期各算一遍，标出共振">
            <input type="checkbox" checked={mtf} onChange={(e) => setMtf(e.target.checked)} />
            多周期共振
          </label>
          <div className="toolbar-gap" />
          <button className="btn xs accent" disabled={!ready || busy === 'analyze'} onClick={() => void analyze()}>
            {busy === 'analyze' ? '分析中…' : '分析单品种'}
          </button>
          <button className="btn xs ghost" disabled={!ready || busy === 'scan'} onClick={() => void runScan()}>
            {busy === 'scan' ? '扫描中…' : '分析全部'}
          </button>
        </div>
      </div>

      {err && <p className="note err">{err}</p>}

      {analysis && (
        <>
          <ResearchCards a={analysis} priceRound={priceRoundOf(analysis.symbol)} />
          {analysis.engine.adjust_warning && <p className="note warn">{analysis.engine.adjust_warning}</p>}

          <div className="panel chart-panel">
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

          <div className="panel">
            <div className="panel-head">
              <h3>支撑 / 阻力带</h3>
              <span className="dim">{tfLabel} · {analysis.data_bars} 根 K 线</span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="txt">类型</th>
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
                    <tr>
                      <td colSpan={12} className="dim cell-center">
                        距离带（0.5~5 ATR）内没有合格的位。换周期、换方向，或者把「每侧档位」调大一点
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {analysis.engine.prob_ready === false && (
              <p className="panel-foot">概率模型没加载，所以「触及/守住/有效概率」是空的；位置和强度照常算。</p>
            )}
          </div>

          <div className="note caveat">
            <b>这些数字该怎么用</b>
            <p>{analysis.summary.caveat}</p>
            <p>
              分位档（Q1~Q5）和「该档历史守住率」来自上游在 A 股日线上的标定样本，
              搬到加密/期货上只能当参照，不是这里的胜率。
            </p>
          </div>
        </>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>全市场扫描</h3>
          <span className="dim">按有效概率（触及 × 守住）排序</span>
        </div>
        <ScanTable scan={scan} loading={busy === 'scan'} priceRoundOf={priceRoundOf} onPick={pickRow} />
      </div>

      <p className="foot">
        以上内容由算法基于历史行情自动生成，仅供技术分析参考，不构成任何投资建议。
      </p>
    </section>
  );
}

function ZoneRow({ z, round }: { z: Zone; round: number }) {
  const pct = (v: number | null) => (v === null ? '—' : Math.round(v * 100) + '%');
  const dist = z.distance_pct >= 0 ? '+' + z.distance_pct.toFixed(2) + '%' : z.distance_pct.toFixed(2) + '%';
  return (
    <tr>
      <td className={'txt ' + (z.zone_type === 'support' ? 's' : 'r')}>{z.zone_type === 'support' ? '支撑' : '阻力'}</td>
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
