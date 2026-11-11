import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isNative, saveTarget, probeServer } from '../lib/endpoint.ts';

/** 内置服务端固定这个端口：手机上没人和它抢 */
const EMBEDDED = 'http://127.0.0.1:8787';
const TOKEN_KEY = 'xf-rine:node-token';

/**
 * 等端口等多久。
 *
 * 第一次启动要先把服务端从 APK 里解出来再起运行时，慢机器上十几秒是正常的；
 * 但也不必死等 —— Node 那边一旦确认失败（abort）会立刻报上来，这里跟着停。
 */
const WAIT_MS = 45_000;
const STEP_MS = 500;

type Stage = 'boot' | 'ok' | 'fail' | 'remote';

/**
 * App 自己的访问口令。
 *
 * 手机上的服务端绑在 127.0.0.1，而 Android 的回环是整个设备共用的 ——
 * 同一台手机里别的应用也能连到那个端口。所以服务端要求「连本机也带口令」，
 * 口令在这里生成、存起来，启动 Node 时通过环境变量交给它。
 *
 * 存起来是为了页面重载后还能对上：重载会重新跑一遍这段，但 Node 只会启动一次。
 */
function nodeToken(): string {
  const fallback = () => 't' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    const cur = localStorage.getItem(TOKEN_KEY);
    if (cur && cur.length >= 16) return cur;
    const t = (globalThis.crypto?.randomUUID?.() ?? fallback()).replace(/-/g, '');
    localStorage.setItem(TOKEN_KEY, t);
    return t;
  } catch {
    // 隐私模式下 localStorage 会抛异常，这一次就用手上这个
    return fallback();
  }
}

/** Node 那边报上来的一行启动记录 */
interface BootLine {
  stage: string;
  line: string;
}

/**
 * 启动内置服务端。
 *
 * Node 运行时就在 App 进程里，起来之后在 127.0.0.1:8787 上开一个接口。
 * 起不来的时候（原生库没装上、脚本写错、端口被占）要在这里说出来，
 * 不能让人对着一屏空图表猜是没行情还是没启动。
 *
 * 光说「没开起端口」不够 —— 真正的原因在 Node 那边的输出里。
 * 所以 mobile/nodejs/index.js 会把启动过程一路喂上来（stage/line），
 * 这里顺手记下来，失败时原样摆给用户看。
 */
async function bootEmbedded(
  onLine: (line: BootLine) => void,
): Promise<{ ok: boolean; token: string; error?: string }> {
  const token = nodeToken();
  /**
   * 「已经在跑了」不是失败，是常态：页面重载、点重试、从后台回来、开发模式双调用，
   * 都会走到这里，而运行时那一次启动本来就是好的。
   *
   * 插件抛的是 code=NODE_ALREADY_RUNNING、message="The Node.js runtime is already running."，
   * 以前只拿下划线那个形状去匹配，空格版本匹配不上，于是这一句英文报错直接甩到用户脸上。
   * 现在两种形状都认，而且不管它抛什么，都先等端口 —— 端口通了就说明没问题。
   */
  let startError = '';
  /** Node 报上来的「起不来了」的原因，非空就别再等了 */
  let aborted = '';
  try {
    const { Nodejs } = await import('@capawesome/capacitor-nodejs');
    // 先挂监听再启动：启动过程里的话一句都不能漏
    await Nodejs.addListener('message', (e) => {
      const p = (e as { args?: unknown[] })?.args?.[0] as
        | { kind?: string; stage?: string; line?: string }
        | undefined;
      if (!p || p.kind !== 'boot') return;
      const line = { stage: String(p.stage ?? ''), line: String(p.line ?? '') };
      onLine(line);
      // Node 自己已经确认起不来了，别再让用户干等
      if (line.stage === 'abort') aborted = line.line;
    });
    await Nodejs.start({
      script: 'index.js',
      env: { REMOTE_TOKEN: token, XFRINE_REQUIRE_TOKEN: '1' },
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = String(err?.code ?? '');
    const msg = String(err?.message ?? e);
    if (!/already[\s_-]*running/i.test(code + ' ' + msg)) startError = msg || '内置服务端没起来';
  }

  let last = '';
  for (let waited = 0; waited < WAIT_MS; waited += STEP_MS) {
    const r = await probeServer(EMBEDDED, token, 1500);
    if (r.ok) return { ok: true, token };
    last = r.error ?? '';
    // 口令对不上说明端口上跑的是上一次没退干净的实例，等下去也不会变
    if (last.includes('口令')) break;
    if (aborted) break;
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
  }
  // 端口通但口令对不上：上一次没退干净，还带着旧口令在跑
  if (last.includes('口令')) {
    return { ok: false, token, error: '端口上有另一个实例在跑，口令对不上。把 App 彻底关掉（最近任务里划掉）再打开。' };
  }
  /**
   * 原因只留第一行。
   *
   * Node 报的是一整段堆栈，全塞进这个红框就变成一屏字，反而看不见最要紧那句；
   * 完整的在下面那个日志块里，一字不少。
   */
  const headline = (text: string): string => {
    const first = text.split('\n')[0]!.replace(/\s+$/, '');
    return first.length > 140 ? first.slice(0, 140) + '…' : first;
  };

  return {
    ok: false,
    token,
    // 真起不来才把启动时报的原因说出来，不然只有一句「没开起端口」不好查
    error: startError
      ? '内置服务端没起来：' + headline(startError)
      : aborted
        ? '内置服务端没起来：' + headline(aborted)
        : '内置服务端没开起端口（' + WAIT_MS / 1000 + ' 秒）',
  };
}

/**
 * App 的第一屏。
 *
 * 手机上是「自带服务端」：先把 Node 拉起来、等接口通，再放主界面进来。
 * 电脑（和浏览器）没有这一步，直接过。
 *
 * 还剩一条后路：内置服务端怎么都起不来时，可以改成连电脑上跑的那个。
 * 用不上最好，但比让人对着一个打不开的 App 强。
 */
export default function ConnectGate({ children }: { children: ReactNode }) {
  const native = isNative();
  const [stage, setStage] = useState<Stage>(native ? 'boot' : 'ok');
  const [error, setError] = useState('');
  /** 启动过程里 Node 报上来的话，失败时贴出来，成功就丢掉 */
  const [log, setLog] = useState<string[]>([]);
  const [tail, setTail] = useState('');
  // 手动连电脑时才用
  const [addr, setAddr] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  /** 一次启动只跑一遍：StrictMode 会把 effect 走两次 */
  const running = useRef(false);

  useEffect(() => {
    if (!native || stage !== 'boot') return;
    if (running.current) return;
    running.current = true;
    let alive = true;
    // 失败前等着的那几十秒里，这一屏最好也在动，别让人以为死了
    const pending: string[] = [];

    void bootEmbedded(({ line }) => {
      if (!alive) return;
      pending.push(line);
      setTail(line);
      // 只留最后几十行：多了页面上的错误框撑爆，也没人看得完
      setLog(pending.slice(-40));
    }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        // 地址和口令在这里定死，后面所有请求都拼到它前面、带上它
        saveTarget(EMBEDDED, r.token);
        setStage('ok');
        return;
      }
      setError(r.error ?? '内置服务端没起来');
      setStage('fail');
    });
    return () => { alive = false; };
  }, [native, stage]);

  if (stage === 'ok') return <>{children}</>;

  if (stage === 'boot') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>正在启动</h1>
          <p className="hint">第一次启动要解压服务端，慢一点正常。</p>
          {tail && <div className="gate-step">{tail}</div>}
        </div>
      </div>
    );
  }

  const connectRemote = async () => {
    setBusy(true);
    setError('');
    const r = await probeServer(addr, token);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? '连不上');
      return;
    }
    saveTarget(addr, token);
    setStage('ok');
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>服务端没起来</h1>
        <p className="hint">程序自带的服务端没能启动，先把原因记下来：</p>
        {error && <div className="gate-err">{error}</div>}
        {/* Node 那边说了什么，原样摆出来 —— 不然只有一句超时，没法查 */}
        {log.length > 0 && (
          <pre className="gate-log">{log.join('\n')}</pre>
        )}

        <button
          className="btn accent"
          style={{ width: '100%' }}
          onClick={() => {
            setError('');
            setTail('');
            running.current = false;
            setStage('boot');
          }}
        >
          再试一次
        </button>

        {stage === 'fail' && (
          <>
            <div className="hint" style={{ marginTop: 16, marginBottom: 8 }}>
              还是起不来的话，可以改成连电脑上跑的那个（同一个 Wi-Fi）：
            </div>
            <div className="field">
              <label>服务器地址</label>
              <input
                className="input mono"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="192.168.1.5:8787"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
              />
            </div>
            <div className="field">
              <label>访问口令</label>
              <input
                className="input mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="电脑设置页里的那串"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
            <button className="btn ghost" style={{ width: '100%' }} onClick={connectRemote} disabled={busy || !addr.trim()}>
              {busy ? '连接中…' : '连电脑'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
