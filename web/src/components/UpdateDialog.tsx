import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  apkDownloadUrl,
  desktopBridge,
  isDesktopClient,
  phoneUpdate,
  savePendingUpdate,
  type InstallPackage,
  type UpdateCheck,
  type UpdateProgress,
} from '../lib/update.ts';
import {
  discardPendingPackage,
  installPendingPackage,
  installPermission,
  openInstallPermission,
  type AppUpdatePermission,
} from '../lib/appUpdate.ts';

/**
 * 更新弹窗。
 *
 * 两种用法共用一套排版：
 *   发现新版本 —— 显示这一版的更新日志，可以「稍后更新」或者现在装；
 *   刚升级完   —— 显示当前这版的更新日志，只有一个「知道了」。
 *
 * 三条安装路径，点下去之后的经历不一样：
 *
 *   - **电脑端**：「开始更新」交给 Electron 主进程，下载、校验、静默安装、自动重启。
 *   - **手机端**：页面自己驱动。走本机服务端那条和电脑端相同的下载接口，进度实时回来；
 *     下完先查「安装未知应用」，没开就把人送到系统那个开关页，回来再装；
 *     已经下好但没装成的，下次进来直接给「立即安装」。
 *   - **浏览器**：没有安装包可装，退回「把地址交给浏览器」的老做法。
 */

type Phase = 'idle' | 'download' | 'verify' | 'ready' | 'permission' | 'install' | 'error';

/** 手机那条路上，「下完了还没装」的那个包的来源：刚下的，或者上次留下的 */
type InstallState = InstallPackage | null;

interface Props {
  mode: 'available' | 'updated' | 'install';
  info: UpdateCheck;
  /** 打开弹窗时本地已经躺着的安装包（手机端才有） */
  initialPending?: InstallPackage | null;
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

export default function UpdateDialog({ mode, info, initialPending, onClose }: Props) {
  const phone = phoneUpdate();
  /** 手机上这个包已经落地了：弹窗一打开就是「可以装了」，不是「再下一次」 */
  const seeded: InstallState = initialPending ?? null;
  const [phase, setPhase] = useState<Phase>(seeded ? 'ready' : 'idle');
  const [pkg, setPkg] = useState<InstallState>(seeded);
  const [progress, setProgress] = useState<UpdateProgress | null>(
    seeded ? { phase: 'download', received: seeded.size, total: seeded.size } : null,
  );
  const [permission, setPermission] = useState<AppUpdatePermission | null>(null);
  const [error, setError] = useState('');
  /** 安卓浏览器那条路用的交代：下载和安装都由系统接手，页面这边帮不上忙 */
  const [hint, setHint] = useState('');
  /** 系统安装器弹出来之后，等用户装完、从别处回到 App 再接着收尾 */
  const [installing, setInstalling] = useState(false);
  const unsubscribe = useRef<null | (() => void)>(null);

  const desktop = isDesktopClient();
  const current = info.self?.version || info.current;
  const latest = info.latest;
  const notes = mode === 'updated'
    ? (info.self?.notes ?? '')
    : (info.latest?.notes ?? pkg?.notes ?? '');
  const targetVersion = mode === 'updated' ? current : (latest?.version ?? pkg?.version ?? '');
  const busy = phase === 'download' || phase === 'verify' || phase === 'install';

  useEffect(() => () => { unsubscribe.current?.(); }, []);

  /**
   * 从系统那个开关页回来就复检一次权限。
   *
   * 用户去设置里打开了「安装未知应用」，回来时 App 只是重新可见，页面没有任何事件 ——
   * 不复检的话人看到的是那个「去允许」按钮一直摆着，以为没生效，再去点一遍。
   * 有的 ROM 切回来不发 resume，所以 appStateChange 也听一份。
   */
  useEffect(() => {
    if (!phone) return;
    let alive = true;
    const recheck = () => {
      if (!alive) return;
      void (async () => {
        const state = await installPermission();
        if (!alive) return;
        setPermission(state);
        if (state.granted) setHint('');
      })();
    };
    const listeners: { remove: () => Promise<void> | void }[] = [];
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        listeners.push(await App.addListener('resume', recheck));
        listeners.push(await App.addListener('appStateChange', ({ isActive }) => { if (isActive) recheck(); }));
      } catch { /* 插件没进来：退化成手动点「已允许，继续」 */ }
    })();
    return () => {
      alive = false;
      for (const listener of listeners) void listener.remove();
    };
  }, [phone]);

  /**
   * 被权限卡住时，一旦权限到位就自己往下走。
   *
   * 放在这里而不是塞进上面那个复检里：从设置页回来、或者用户手动点了「已允许，继续」，
   * 两条路都是「权限变成了允许」，收口在这一处，就不会装两次。
   */
  useEffect(() => {
    if (phase !== 'permission' || !permission?.granted) return;
    void runInstaller();
    // runInstaller 每次都新建；依赖只看状态，不然会反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, permission]);

  /** 进「检查权限」这一步：先问系统，没开就摆选项，开过了就直接装 */
  const checkPermissionThenInstall = async () => {
    if (!phone) return;
    setError('');
    const state = await installPermission();
    setPermission(state);
    if (state.granted) {
      void runInstaller();
      return;
    }
    setPhase('permission');
  };

  /** 真正把包交给系统安装器 */
  const runInstaller = async () => {
    setPhase('install');
    const result = await installPendingPackage();
    if (result.started) {
      setInstalling(true);
      return;
    }
    setInstalling(false);
    if (result.reason === 'permission') {
      /*
       * 原生又说不许装：把本地这个「已允许」也改成没允许。
       *
       * 不改的话，下面那个「权限到位就继续」的 effect 会看到
       * phase=permission 且 granted=true，立刻再装一次 —— 系统一直拒，
       * 弹窗就在 permission 和 install 之间来回闪，日志里刷满同样的失败。
       */
      setPermission((now) => ({ granted: false, sdk: now?.sdk ?? 0 }));
      setPhase('permission');
    } else {
      setPhase('error');
    }
    setError(installErrorText(result.reason));
  };

  /**
   * 下载中途取消。
   *
   * 一个包七八十兆，慢网下要几分钟。不给出口的话，弹窗在这段时间里连关都关不掉
   * （busy 状态挡住了关窗口），用户只能杀进程 —— 下次进来还得从头下。
   * 原生那边看到取消就停写、删掉 .part；已经下完的包不受影响。
   */
  const cancelDownload = async () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    await discardPendingPackage();
    setPkg(null);
    setProgress(null);
    setPhase('idle');
  };

  /** 手机端：下 → 校验 → 查权限 → 装。每一步都留在弹窗里，不让页面失去控制 */
  const startPhone = async () => {
    if (!phone || !latest) return;
    setError('');
    setHint('');
    // 先存一份说明：装完第一次启动要是没网，也要能说清这次更新了什么
    savePendingUpdate(latest.version, latest.notes);
    setPhase('download');
    setProgress({ phase: 'download', received: 0, total: latest.asset.size });
    unsubscribe.current?.();
    unsubscribe.current = phone.onProgress((next) => {
      setProgress(next);
      if (next.phase === 'verify') setPhase('verify');
    });
    try {
      const ready = await phone.download({
        url: apkDownloadUrl(latest.version),
        version: latest.version,
        name: latest.asset.name,
        size: latest.asset.size,
        digest: latest.asset.digest,
        notes: latest.notes,
      });
      setPkg(ready);
      setProgress({ phase: 'download', received: ready.size, total: ready.size });
      await checkPermissionThenInstall();
    } catch (e) {
      setPhase('error');
      setError((e as Error)?.message || '下载更新包失败');
    } finally {
      unsubscribe.current?.();
      unsubscribe.current = null;
    }
  };

  const start = async () => {
    setError('');
    if (phone) {
      await startPhone();
      return;
    }
    if (!desktop) {
      // 浏览器：装不了，只能把地址交出去
      setHint('已在浏览器里打开下载。下载完成后点开安装包，按系统提示确认即可升级。');
      if (latest) window.location.href = apkDownloadUrl(latest.version);
      return;
    }
    const bridge = desktopBridge();
    if (!bridge || !latest) return;
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

  /**
   * 「去允许」：跳到系统的开关页。
   *
   * 跳不成（老系统、被改过的 ROM）不能只留一句「打不开」——
   * 把路径写出来，用户照着走也能打开。返回 App 之后由发起方复检权限。
   */
  const openSettings = async () => {
    if (!phone) return;
    const opened = await openInstallPermission();
    if (!opened) {
      setHint('没能直接打开设置。请到「设置 → 应用 → 巡风 → 安装未知应用」里打开开关，再回来。');
    }
  };

  /**
   * 「已允许，继续」：有的 ROM 切回来不发 resume 事件，给一个手动的口子。
   * 只负责把状态问回来，装不装由上面那个看权限的 effect 决定。
   */
  const recheckPermission = async () => {
    if (!phone) return;
    const state = await installPermission();
    setPermission(state);
    if (state.granted) setHint('');
  };

  /**
   * 「稍后安装」：关掉弹窗，包留在本地。
   *
   * 这正是这一整套的意义所在 —— 下次启动时启动判定会看到这个包比装着的版本新，
   * 于是弹的是「更新已下载 / 立即安装」，而不是让用户再下一次一百多兆。
   * 真的不想装了才走 discard，把包删掉。
   */
  const giveUp = () => onClose();

  /** 明确不要这一版：删包，这次不再提 */
  const dropPackage = async () => {
    await discardPendingPackage();
    setPkg(null);
    setPhase('idle');
    onClose();
  };

  const percent = progress && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
    : 0;

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal update-modal">
        <header>
          <h2>{dialogTitle(mode, targetVersion)}</h2>
          {!busy && <button className="x" onClick={onClose}>×</button>}
        </header>

        <div className="body">
          <div className="update-meta">{dialogMeta(mode, current, targetVersion, pkg)}</div>
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
          {phase === 'verify' && (
            <div className="update-progress">
              <div className="update-bar"><i style={{ width: '100%' }} /></div>
              <div className="hint">下载完成，正在核对 sha256…</div>
            </div>
          )}
          {(phase === 'ready' || phase === 'install' || phase === 'permission') && pkg && (
            <div className="update-file">
              <div>{pkg.name}</div>
              <div className="muted">{pkg.path}</div>
            </div>
          )}
          {phase === 'install' && (
            <div className="hint">
              {installing ? '系统安装程序已弹出，按它的提示确认安装即可。' : '正在唤起系统安装程序…'}
            </div>
          )}
          {phase === 'permission' && (
            <>
              <div className="update-error">
                系统还没允许巡风安装应用。没有这个权限，安装程序根本不会弹出来。
              </div>
              <div className="update-actions">
                <button className="btn ghost" onClick={() => void openSettings()}>去允许</button>
                <button className="btn accent" onClick={() => void recheckPermission()}>已允许，继续</button>
              </div>
              <div className="hint update-hint">
                设置里找到「巡风」这一项，打开「安装未知应用 / 安装外部来源应用」；
                各家的叫法不一样，位置都在应用详情页里。
              </div>
            </>
          )}
          {phase === 'error' && <div className="update-error">{error}</div>}
          {hint && <div className="hint update-hint">{hint}</div>}
        </div>

        <footer>
          {/* 权限那一步的按钮在正文里（「去允许」「已允许，继续」），底栏让位给它们 */}
          {phase === 'permission' ? null
            : mode === 'updated' ? (
              <button className="btn accent" onClick={onClose}>知道了</button>
            ) : phase === 'install' ? (
              /*
               * 已经交给系统安装程序。
               *
               * 这里不给「不要这一版」：系统安装器正在读那个文件，
               * 这时候删掉它，用户拿到的是「解析包时出现问题」。
               * 真不想装了，是在安装失败回到 error/ready 之后才有的选择。
               */
              installing ? (
                <button className="btn accent" onClick={onClose}>知道了</button>
              ) : null
            ) : busy ? (
              /*
               * 下载/校验中途。
               *
               * 弹窗在这段时间里关不掉（外面那层也会被 busy 挡），
               * 慢网下要等好几分钟 —— 必须给一个「取消」的出口。
               * 已经开始装（phase=install）不算在内：那时文件正在被系统读。
               */
              (phase === 'download' || phase === 'verify') ? (
                <button className="btn ghost" onClick={() => void cancelDownload()}>取消下载</button>
              ) : null
            ) : phase === 'ready' ? (
              <div className="update-actions">
                <button className="btn ghost" onClick={giveUp}>稍后安装</button>
                <button className="btn accent" onClick={() => void checkPermissionThenInstall()}>立即安装</button>
              </div>
            ) : phase === 'error' && pkg ? (
              /*
               * 装失败了但包还在：给「删掉重下」，而不是让用户再下一次。
               *
               * 签名对不上、包损坏这两种，重下也未必有用 —— 先把包删干净，
               * 下次启动的判定才会回落到「发现新版本」，而不是一直推这个坏包。
               */
              <div className="update-actions">
                <button className="btn ghost" onClick={() => void dropPackage()}>删掉安装包</button>
                <button className="btn accent" onClick={onClose}>关闭</button>
              </div>
            ) : (
              <div className="update-actions">
                <button className="btn ghost" onClick={onClose}>稍后更新</button>
                <button className="btn accent" disabled={!latest} onClick={() => void start()}>
                  下载安装包
                </button>
              </div>
            )}
          {(phase === 'idle' || phase === 'ready') && (
            <div className="hint update-foot">{desktop
              ? '更新会关掉程序，装完自动打开；密钥和设置不受影响。'
              : '下载完成后由系统安装程序接手，装完照常打开；密钥和设置不受影响。'}</div>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 三种模式的标题 */
function dialogTitle(mode: Props['mode'], version: string): string {
  if (mode === 'updated') return '已更新到 ' + v(version);
  if (mode === 'install') return '更新已下载 ' + v(version);
  return '发现新版本 ' + v(version);
}

/** 标题下面那行说明 */
function dialogMeta(mode: Props['mode'], current: string, target: string, pkg: InstallPackage | null): string {
  if (mode === 'updated') return '这次更新带了这些内容：';
  if (mode === 'install') return '安装包已经下好了（' + mb(pkg?.size ?? 0) + '），装完就是 ' + v(target) + '。';
  return '当前 ' + v(current) + '，可以更新到 ' + v(target) + '。';
}

/** 原生那边给的是原因码：翻成能照着做的句子 */
function installErrorText(reason?: string): string {
  switch (reason) {
    case 'permission': return '系统还没允许安装应用，先去打开那个开关。';
    case 'missing': return '安装包不在了，得重新下载一次。';
    case 'older': return '这个包不比现在装着的版本新，系统不会覆盖安装。';
    case 'signature': return '这个包和装着的不是同一个签名（换了密钥），只能卸载重装。';
    case 'bad': return '安装包打不开，可能下载不完整，删掉重下一次。';
    case 'launch': return '没能打开系统安装程序。';
    default: return '安装没有启动成功。';
  }
}
