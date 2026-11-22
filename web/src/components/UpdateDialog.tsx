import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  apkDownloadUrl,
  desktopBridge,
  isDesktopClient,
  savePendingUpdate,
  type UpdateCheck,
  type UpdateProgress,
} from '../lib/update.ts';

/**
 * 更新弹窗。
 *
 * 两种用法共用一套排版：
 *   发现新版本 —— 显示这一版的更新日志，可以「稍后更新」或者现在装；
 *   刚升级完   —— 显示当前这版的更新日志，只有一个「知道了」。
 *
 * 桌面端点「开始更新」交给 Electron 主进程（下载、校验、静默安装、重启）；
 * 安卓端只能把安装包交给系统浏览器，装不装、什么时候装由系统安装器决定。
 */

type Phase = 'idle' | 'download' | 'verify' | 'install' | 'error';

interface Props {
  mode: 'available' | 'updated';
  info: UpdateCheck;
  onClose: () => void;
}

/** 版本号统一写成 v 开头，和 Release 标题对得上 */
function v(version: string): string {
  return version ? 'v' + version.replace(/^v/i, '') : '未知版本';
}

function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;

/** 行内：代码、加粗、链接。其余原样输出，React 会自己转义 */
function inline(text: string, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const token = match[0];
    const key = prefix + '-' + index;
    index += 1;
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<b key={key}>{token.slice(2, -2)}</b>);
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      // 只认 http(s)：更新说明是仓库里写的，但这里不给自己留一条 javascript: 的口子
      if (link && /^https?:\/\//i.test(link[2])) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>,
        );
      } else {
        out.push(token);
      }
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 更新日志的极简排版。
 *
 * Release 里写的是 GitHub 的 markdown：标题、短横线列表、**加粗**、`代码`。
 * 不引一整库 markdown，只认这几种最常见的样子，认不出来的一行原样显示 ——
 * 原样显示至少不丢字，乱排版才会让人以为更新说明坏了。
 */
function Notes({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered: string[] = [];
  let fence: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (list.length) {
      const items = list;
      list = [];
      blocks.push(
        <ul key={'ul-' + key}>
          {items.map((item, i) => <li key={i}>{inline(item, 'li-' + key + '-' + i)}</li>)}
        </ul>,
      );
      key += 1;
    }
    if (ordered.length) {
      const items = ordered;
      ordered = [];
      blocks.push(
        <ol key={'ol-' + key}>
          {items.map((item, i) => <li key={i}>{inline(item, 'ol-' + key + '-' + i)}</li>)}
        </ol>,
      );
      key += 1;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        const code = fence.join('\n');
        fence = null;
        blocks.push(<pre key={'pre-' + key}><code>{code}</code></pre>);
        key += 1;
      } else {
        fence.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushList();
      fence = [];
      continue;
    }
    if (!line.trim()) { flushList(); continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push(<h4 key={'h-' + key}>{inline(heading[1], 'h-' + key)}</h4>);
      key += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
      flushList();
      blocks.push(<hr key={'hr-' + key} />);
      key += 1;
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      if (ordered.length) flushList();
      list.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      if (list.length) flushList();
      ordered.push(numbered[1]);
      continue;
    }
    flushList();
    blocks.push(<p key={'p-' + key}>{inline(line, 'p-' + key)}</p>);
    key += 1;
  }
  if (fence !== null) {
    blocks.push(<pre key={'pre-' + key}><code>{fence.join('\n')}</code></pre>);
  }
  flushList();
  return <div className="update-notes">{blocks}</div>;
}

export default function UpdateDialog({ mode, info, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState('');
  /** 安卓要把下载交给浏览器，给一句交代；不然用户回来只看到弹窗还在 */
  const [hint, setHint] = useState('');
  const unsubscribe = useRef<null | (() => void)>(null);

  useEffect(() => () => { unsubscribe.current?.(); }, []);

  const desktop = isDesktopClient();
  const current = info.self?.version || info.current;
  const latest = info.latest;
  const notes = mode === 'updated' ? (info.self?.notes ?? '') : (latest?.notes ?? '');
  const targetVersion = mode === 'updated' ? current : (latest?.version ?? '');
  const busy = phase === 'download' || phase === 'verify' || phase === 'install';

  const start = async () => {
    if (!latest) return;
    setError('');
    const bridge = desktopBridge();
    if (!desktop || !bridge) {
      // 安卓：把安装包交给系统浏览器。页面留在前台，下载和安装由系统接手，
      // 所以这里不进入「更新中」状态 —— 用户从浏览器回来还能关掉这个弹窗
      setHint('已在浏览器里打开下载。下载完成后点开安装包，按系统提示确认即可升级。');
      window.location.href = apkDownloadUrl(latest.version);
      return;
    }
    // 先存一份说明：装完第一次启动要是没网，也要能说清这次更新了什么
    savePendingUpdate(latest.version, latest.notes);
    setPhase('download');
    setProgress({ phase: 'download', received: 0, total: latest.asset.size });
    unsubscribe.current?.();
    unsubscribe.current = bridge.update.onProgress((next) => {
      setProgress(next);
      if (next.phase === 'verify') setPhase('verify');
      if (next.phase === 'install') setPhase('install');
    });
    try {
      const result = await bridge.update.start({
        version: latest.version,
        name: latest.asset.name,
        size: latest.asset.size,
        digest: latest.asset.digest,
      });
      if (!result.ok) {
        unsubscribe.current?.();
        unsubscribe.current = null;
        setPhase('error');
        setError(result.error || '更新没有装成功');
      }
    } catch (e) {
      setPhase('error');
      setError((e as Error)?.message || '更新失败');
    }
  };

  const percent = progress && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
    : 0;

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal update-modal">
        <header>
          <h2>{mode === 'updated' ? '已更新到 ' + v(targetVersion) : '发现新版本 ' + v(targetVersion)}</h2>
          {!busy && <button className="x" onClick={onClose}>×</button>}
        </header>

        <div className="body">
          <div className="update-meta">
            {mode === 'updated'
              ? '这次更新带了这些内容：'
              : '当前 ' + v(current) + '，可以更新到 ' + v(targetVersion) + '。'}
          </div>
          {notes.trim()
            ? <Notes text={notes} />
            : <div className="hint">这一版没有写更新说明。</div>}

          {phase === 'download' && (
            <div className="update-progress">
              <div className="update-bar"><i style={{ width: percent + '%' }} /></div>
              <div className="hint">
                正在下载安装包 {percent}%（{mb(progress?.received ?? 0)} / {mb(progress?.total ?? 0)}）
              </div>
            </div>
          )}
          {phase === 'verify' && <div className="hint">正在校验安装包…</div>}
          {phase === 'install' && <div className="hint">正在安装，程序会自动重启。</div>}
          {phase === 'error' && <div className="update-error">{error}</div>}
          {hint && <div className="hint update-hint">{hint}</div>}
        </div>

        <footer>
          {mode === 'updated' ? (
            <button className="btn accent" onClick={onClose}>知道了</button>
          ) : (
            <div className="update-actions">
              <button className="btn ghost" disabled={busy} onClick={onClose}>稍后更新</button>
              <button className="btn accent" disabled={busy || !latest} onClick={() => void start()}>
                {busy ? '更新中…' : desktop ? '开始更新' : '下载安装包'}
              </button>
            </div>
          )}
          {desktop && phase === 'idle' && latest && (
            <div className="hint update-foot">更新会关掉程序，装完自动打开；密钥和设置不受影响。</div>
          )}
        </footer>
      </div>
    </div>
  );
}
