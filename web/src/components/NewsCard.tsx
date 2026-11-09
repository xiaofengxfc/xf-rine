import type { NewsDigest } from '../lib/api.ts';
import { fmtAgo } from '../lib/format.ts';

interface Props {
  digest: NewsDigest | null;
  contract: string;
  loading: boolean;
}

const STANCE_TEXT: Record<NewsDigest['stance'], string> = {
  bullish: '偏多',
  neutral: '中性',
  bearish: '偏空',
};

export default function NewsCard({ digest, contract, loading }: Props) {
  const base = contract.split('_')[0] ?? contract;
  const okFeeds = digest?.feeds.filter((f) => f.ok).length ?? 0;
  const totalFeeds = digest?.feeds.length ?? 0;

  return (
    <section className="card">
      <div className="card-head">
        <h3>新闻雷达</h3>
        <span className="dim" style={{ fontSize: 10 }}>
          {digest ? `${okFeeds}/${totalFeeds} 个源` : loading ? '抓取中' : ''}
        </span>
      </div>
      <div className="card-body">
        {!digest && (
          <div className="empty">{loading ? '正在抓取新闻…' : '还没有新闻数据'}</div>
        )}

        {digest && (
          <>
            <div className="news-stance">
              <span className={`news-tag ${digest.stance}`}>{STANCE_TEXT[digest.stance]}</span>
              <div className="news-meter" title={`情绪分 ${digest.sentiment.toFixed(2)}`}>
                <div className="news-meter-track">
                  <div
                    className={`news-meter-fill ${digest.stance}`}
                    style={{ width: `${Math.min(100, Math.abs(digest.sentiment) * 100)}%` }}
                  />
                </div>
                <span className="news-score">{digest.sentiment.toFixed(2)}</span>
              </div>
            </div>

            {digest.items.length === 0 ? (
              <>
                <div className="empty" style={{ padding: '10px 0 4px' }}>{digest.note}</div>
                {okFeeds > 0 && (
                  <div className="news-note dim">
                    {base} 这类合约媒体很少覆盖，卡片空着是真实情况，不是抓取失败。
                  </div>
                )}
                {okFeeds === 0 && digest.feeds.length > 0 && (
                  <div className="news-note dim">
                    {digest.feeds.map((f) => `${f.name}（${f.error ?? '失败'}）`).join('、')}
                  </div>
                )}
              </>
            ) : (
              <>
                <ul className="news-list">
                  {digest.items.map((it) => (
                    <li key={it.url || it.title}>
                      <a href={it.url} target="_blank" rel="noreferrer" title={it.title}>
                        <span className={`news-dot ${it.sentiment >= 0.15 ? 'bullish' : it.sentiment <= -0.15 ? 'bearish' : 'neutral'}`} />
                        <span className="news-title">{it.title}</span>
                      </a>
                      <div className="news-meta">
                        <span>{it.source}</span>
                        <span>{fmtAgo(it.publishedAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="news-note">{digest.note}</div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
