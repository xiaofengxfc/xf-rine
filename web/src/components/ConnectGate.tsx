import { useEffect, useState, type ReactNode } from 'react';
import { isNative, saveTarget, probeServer } from '../lib/endpoint.ts';

/** 内置服务端固定这个端口：手机上没人和它抢 */
const EMBEDDED = 'http://127.0.0.1:8787';
const TOKEN_KEY = 'xf-rine:node-token';

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

/**
 * 启动内置服务端。
 *
 * Node 运行时就在 App 进程里，起来之后在 127.0.0.1:8787 上开一个接口。
 * 起不来的时候（原生库没装上、脚本写错）要在这里说出来，
 * 不能让人对着一屏空图表猜是没行情还是没启动。
 */
async function bootEmbedded(): Promise<{ ok: boolean; token: string; error?: string }> {
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
  try {
    const { Nodejs } = await import('@capawesome/capacitor-nodejs');
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

  // Node 起来到端口能连上，一般一两秒
  let last = '';
  for (let i = 0; i < 40; i += 1) {
    const r = await probeServer(EMBEDDED, token, 1500);
    if (r.ok) return { ok: true, token };
    last = r.error ?? '';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // 端口通但口令对不上：上一次没退干净，还带着旧口令在跑
  if (last.includes('口令')) {
    return { ok: false, token, error: '端口上有另一个实例在跑，口令对不上。把 App 彻底关掉（最近任务里划掉）再打开。' };
  }
  return {
    ok: false,
    token,
    // 真起不来才把启动时报的原因说出来，不然只有一句「没开起端口」不好查
    error: startError ? '内置服务端没起来：' + startError : '内置服务端 20 秒内没开起端口',
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
  // 手动连电脑时才用
  const [addr, setAddr] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native || stage !== 'boot') return;
    let alive = true;
    void bootEmbedded().then((r) => {
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

        <button className="btn accent" style={{ width: '100%' }} onClick={() => { setError(''); setStage('boot'); }}>
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
