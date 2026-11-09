import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, jsend, type AiAnalysis } from '../lib/api.ts';
import { fmtAgo } from '../lib/format.ts';

interface Props {
  contract: string;
  interval: string;
  configured: boolean;
  liveTrading: boolean;
  env: 'testnet' | 'live';
  onOpenSettings: () => void;
}

const VERDICT: Record<AiAnalysis['verdict'], { text: string; cls: string }> = {
  long: { text: '偏多', cls: 'long' },
  short: { text: '偏空', cls: 'short' },
  wait: { text: '观望', cls: 'wait' },
};

export default function AiCard({ contract, interval, configured, liveTrading, env, onOpenSettings }: Props) {
  const [data, setData] = useState<AiAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ label: string; detail: string } | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    if (!configured) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const d = await jsend<AiAnalysis>('POST', '/api/ai/analyze', { contract, interval, refresh });
      if (seq === seqRef.current) setData(d);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof ApiError ? { label: e.label, detail: e.message } : { label: 'ERROR', detail: String(e) });
      setData(null);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [contract, interval, configured]);

  // 切币种或周期时自动分析一次；之后不轮询，模型调用是要花钱的
  useEffect(() => { void load(false); }, [load]);

  // 切走了就把上一个币的结论清掉，别让旧结论挂在新图上
  useEffect(() => {
    setData((prev) => (prev && (prev.contract !== contract || prev.interval !== interval) ? null : prev));
  }, [contract, interval]);

  const v = data ? VERDICT[data.verdict] : null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>AI 分析</h3>
        <span className="dim" style={{ fontSize: 10 }}>
          {data ? `${data.model}${data.cached ? ' · 缓存' : ''}` : configured ? (loading ? '分析中' : '') : '未配置'}
        </span>
      </div>
      <div className="card-body">
        {!configured && (
          <>
            <div className="empty" style={{ padding: '6px 0' }}>还没配置模型</div>
            <div className="ai-note">
              支持任何 OpenAI 兼容接口，官方地址、中转站、本地 Ollama 都行。填接口地址、密钥和模型名就能用。
            </div>
            <button className="btn ghost" style={{ padding: '6px 0', marginTop: 8 }} onClick={onOpenSettings}>
              去设置里填
            </button>
          </>
        )}

        {configured && error && (
          <>
            <div className="ai-note" style={{ color: 'var(--warn)' }}>
              {error.detail || error.label}
            </div>
            <button className="btn ghost" style={{ padding: '6px 0', marginTop: 8 }} onClick={() => void load(true)} disabled={loading}>
              重试
            </button>
          </>
        )}

        {configured && !error && loading && !data && <div className="empty" style={{ padding: '10px 0' }}>正在分析…</div>}

        {configured && !error && data && v && (
          <>
            <div className="ai-head">
              <span className={`ai-verdict ${v.cls}`}>{v.text}</span>
              <div className="ai-conf">
                <div className="ai-conf-track">
                  <div className={`ai-conf-fill ${v.cls}`} style={{ width: `${Math.round(data.confidence * 100)}%` }} />
                </div>
                <span className="ai-conf-num">{Math.round(data.confidence * 100)}%</span>
              </div>
              <button className="ai-refresh" onClick={() => void load(true)} disabled={loading} title="重新分析（不走缓存）">
                {loading ? '…' : '↻'}
              </button>
            </div>

            {data.reasons.length > 0 && (
              <ul className="ai-reasons">
                {data.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}

            {data.conflicts.length > 0 && (
              <div className="ai-conflicts">
                {data.conflicts.map((c, i) => <div key={i}>⚠ {c}</div>)}
              </div>
            )}

            {data.riskNote && <div className="ai-note">最容易翻车的地方：{data.riskNote}</div>}

            {data.raw && (
              <pre className="ai-raw">{data.raw}</pre>
            )}

            {data.usage && (
              <div className="ai-foot">
                {fmtAgo(data.at)} · {data.usage.promptTokens}+{data.usage.completionTokens} token
              </div>
            )}

            <div className="ai-warn">
              这是模型给的参考意见，不是交易信号。
              {liveTrading && env === 'live' ? '实盘下单开着，按自己的判断下单。' : ''}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
