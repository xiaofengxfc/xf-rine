import { useEffect, useState, type ReactNode } from 'react';
import { isNative, saveTarget, probeServer, apiBase, remoteToken } from '../lib/endpoint.ts';

/**
 * App 的第一屏：连电脑。
 *
 * 手机端不再自带服务端。原来那套（把 Node 运行时和整个后端塞进 APK，在手机上
 * 127.0.0.1:8787 起一个接口）能离线用，但代价是：APK 多出几十兆原生库、
 * 每个算法改动都要重打一个包、换机换系统就是一堆加载失败的兼容问题，
 * 而这台手机上跑的还是同一份「读不到本地数据、连不上交易所代理」的后端。
 *
 * 现在手机只是一块屏幕：所有计算在电脑上做，手机负责显示和下单。
 * 所以第一屏只剩一件事 —— 填电脑地址（口令可选，电脑开了远程口令就必填）。
 *
 * 地址会记住：连过一次，下次启动先拿它试一下，通了直接进主界面。
 */

/** 存好的那一对还在不在，在就先试一下：连得上就不用再看这一屏 */
function saved(): { base: string; token: string } | null {
  const base = apiBase();
  if (!base) return null;
  return { base, token: remoteToken() };
}

type Stage = 'boot' | 'ok' | 'ask';

export default function ConnectGate({ children }: { children: ReactNode }) {
  const native = isNative();
  const [stage, setStage] = useState<Stage>(native ? 'boot' : 'ok');
  const [error, setError] = useState('');
  const [addr, setAddr] = useState(() => saved()?.base ?? '');
  const [token, setToken] = useState(() => saved()?.token ?? '');
  const [busy, setBusy] = useState(false);

  // 启动时先用记住的地址探一次。通不了就摆出这一屏，把「上一次为什么没连上」写在上面 ——
  // 直接跳回空表单，用户会以为自己从来没连过。
  useEffect(() => {
    if (!native || stage !== 'boot') return;
    let alive = true;
    const last = saved();
    if (!last) { setStage('ask'); return; }
    void probeServer(last.base, last.token).then((r) => {
      if (!alive) return;
      if (r.ok) { setStage('ok'); return; }
      setError('上次连的 ' + last.base + ' 现在连不上：' + (r.error ?? '没有响应'));
      setStage('ask');
    });
    return () => { alive = false; };
  }, [native, stage]);

  if (stage === 'ok') return <>{children}</>;

  if (stage === 'boot') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>正在连接电脑</h1>
          <p className="hint">用上一次连过的地址试一下。</p>
        </div>
      </div>
    );
  }

  const connect = async () => {
    const a = addr.trim();
    if (!a) return;
    setBusy(true);
    setError('');
    const r = await probeServer(a, token);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? '连不上');
      return;
    }
    saveTarget(a, token);
    setStage('ok');
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>连接电脑</h1>
        <p className="hint">
          所有计算都在电脑上：行情、支撑阻力、下单。手机只是这块屏幕。
        </p>
        <p className="hint" style={{ marginTop: -4 }}>
          先在电脑上打开巡风，然后在设置里打开「允许局域网访问」，那里会显示一串地址和口令。
        </p>

        {error && <div className="gate-err">{error}</div>}

        <div className="field">
          <label>电脑地址</label>
          <input
            className="input mono"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
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
            onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
            placeholder="电脑设置页「手机连接」里那一串（没开就不用填）"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <button
          className="btn accent"
          style={{ width: '100%' }}
          onClick={() => void connect()}
          disabled={busy || !addr.trim()}
        >
          {busy ? '连接中…' : '连接'}
        </button>
        <p className="hint" style={{ marginTop: 10 }}>
          电脑和手机要在同一个 Wi-Fi 里。电脑上的防火墙第一次会问，选「允许」。
        </p>
      </div>
    </div>
  );
}
