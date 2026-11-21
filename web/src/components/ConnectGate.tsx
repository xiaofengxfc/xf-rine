import { useEffect, useState, type ReactNode } from 'react';
import { isNative, saveTarget, probeServer, apiBase, remoteToken } from '../lib/endpoint.ts';

const EMBEDDED = 'http://127.0.0.1:8787';
const TOKEN_KEY = 'xf-rine:node-token';

type Stage = 'boot' | 'ok' | 'fail' | 'remote';

function nodeToken(): string {
  try {
    const current = localStorage.getItem(TOKEN_KEY);
    if (current && current.length >= 16) return current;
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(TOKEN_KEY, token);
    return token;
  } catch {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}

async function bootEmbedded(): Promise<{ token: string }> {
  const token = nodeToken();
  const { PythonEngine } = await import('../lib/pythonEngine.ts');
  const python = await PythonEngine.start({ token });
  const { Nodejs } = await import('@capawesome/capacitor-nodejs');

  try {
    await Nodejs.start({
      script: 'index.js',
      env: {
        REMOTE_TOKEN: token,
        XFRINE_REQUIRE_TOKEN: '1',
        XFRINE_SIDECAR_URL: `http://127.0.0.1:${python.port}`,
        XFRINE_SIDECAR_TOKEN: token,
      },
    });
  } catch (error) {
    if (!/ALREADY_RUNNING/i.test(String((error as Error)?.message ?? error))) throw error;
  }

  let last = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await probeServer(EMBEDDED, token, 1500);
    if (result.ok) return { token };
    last = result.error ?? '';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (last.includes('口令')) {
    throw new Error('本机服务仍在运行，但口令不匹配。请从最近任务中彻底关闭 App 后重试。');
  }
  throw new Error('本机服务在 20 秒内没有启动完成。' + (last ? ` ${last}` : ''));
}

export default function ConnectGate({ children }: { children: ReactNode }) {
  const native = isNative();
  const [stage, setStage] = useState<Stage>(native ? 'boot' : 'ok');
  const [error, setError] = useState('');
  const [addr, setAddr] = useState(() => apiBase());
  const [token, setToken] = useState(() => remoteToken());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native || stage !== 'boot') return;
    let alive = true;
    void bootEmbedded().then(({ token: localToken }) => {
      if (!alive) return;
      saveTarget(EMBEDDED, localToken);
      setStage('ok');
    }).catch((failure: unknown) => {
      if (!alive) return;
      setError((failure as Error).message || '本机服务启动失败');
      setStage('fail');
    });
    return () => { alive = false; };
  }, [native, stage]);

  if (stage === 'ok') return <>{children}</>;

  if (stage === 'boot') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>正在启动巡风</h1>
          <p className="hint">首次启动需要初始化内嵌 Python 和行情服务。</p>
        </div>
      </div>
    );
  }

  const connectRemote = async () => {
    if (!addr.trim()) return;
    setBusy(true);
    setError('');
    const result = await probeServer(addr, token);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? '连接电脑失败');
      return;
    }
    saveTarget(addr, token);
    setStage('ok');
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>{stage === 'fail' ? '本机服务启动失败' : '连接电脑'}</h1>
        {stage === 'fail' ? (
          <>
            <p className="hint">手机会在本机运行行情服务和支撑阻力引擎。</p>
            {error && <div className="gate-err">{error}</div>}
            <button className="btn accent" style={{ width: '100%' }} onClick={() => { setError(''); setStage('boot'); }}>
              重试本机启动
            </button>
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setStage('remote')}>
              连接电脑服务端
            </button>
          </>
        ) : (
          <>
            <p className="hint">连接同一 Wi-Fi 内运行的巡风电脑端。</p>
            {error && <div className="gate-err">{error}</div>}
            <div className="field">
              <label>电脑地址</label>
              <input className="input mono" value={addr} onChange={(event) => setAddr(event.target.value)}
                placeholder="192.168.1.5:8787" spellCheck={false} autoCapitalize="off" autoCorrect="off" inputMode="url" />
            </div>
            <div className="field">
              <label>访问口令</label>
              <input className="input mono" value={token} onChange={(event) => setToken(event.target.value)}
                placeholder="电脑设置页中的访问口令" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
            </div>
            <button className="btn accent" style={{ width: '100%' }} onClick={() => void connectRemote()}
              disabled={busy || !addr.trim()}>
              {busy ? '连接中…' : '连接'}
            </button>
            <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setStage('fail')}>
              返回本机启动
            </button>
          </>
        )}
      </div>
    </div>
  );
}
