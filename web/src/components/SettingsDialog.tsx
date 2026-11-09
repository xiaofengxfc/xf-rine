import { useState } from 'react';
import { jget, jsend, type AppConfig } from '../lib/api.ts';

interface Props {
  config: AppConfig | null;
  onClose: () => void;
  onSaved: () => void;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
}

interface Diag {
  env: 'testnet' | 'live';
  envLabel: string;
  restBaseUrl: string;
  keys: { configured: boolean; hint: string };
  liveTrading: boolean;
  privateOk?: boolean;
  privateError?: string;
  account?: Record<string, string>;
}

export default function SettingsDialog({ config, onClose, onSaved, onToast }: Props) {
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [live, setLive] = useState(config?.liveTrading ?? false);
  const [env, setEnv] = useState<'testnet' | 'live'>(config?.env ?? 'testnet');
  const [diag, setDiag] = useState<Diag | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await jsend('POST', '/api/config/keys', {
        key: key.trim() || undefined,
        secret: secret.trim() || undefined,
        liveTrading: live,
        env,
      });
      onToast('ok', '已写入 server/.env', '密钥和环境热加载，不用重启');
      setKey(''); setSecret('');
      onSaved();
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function runDiag() {
    setBusy(true);
    try {
      const d = await jget<Diag>('/api/diag');
      setDiag(d);
      if (d.privateOk) onToast('ok', '私有接口连通', '账户信息已读到');
      else onToast('err', '私有接口失败', d.privateError);
    } catch (e) {
      onToast('err', '体检失败', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <header>
          <h2>设置</h2>
          <button className="x" onClick={onClose}>×</button>
        </header>
        <div className="body">
          <div className="field">
            <label>环境</label>
            <div className="seg" style={{ width: '100%' }}>
              <button className={env === 'testnet' ? 'on' : ''} onClick={() => setEnv('testnet')} style={{ flex: 1 }}>模拟盘</button>
              <button
                className={env === 'live' ? 'on' : ''}
                onClick={() => { setEnv('live'); setLive(false); }}
                style={{ flex: 1, color: env === 'live' ? 'var(--down)' : undefined }}
              >实盘</button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              模拟盘打 <code>api-testnet.gateapi.io</code>，下单用的是测试网假钱，密钥也要用测试网密钥。
              实盘打 <code>api.gateio.ws</code>，动真钱。行情两种环境都连主网。
            </div>
          </div>

          <div className="field">
            <label>当前密钥</label>
            <div className="hint" style={{ fontFamily: 'var(--mono)' }}>
              {config?.keys.configured ? `已配置 ${config.keys.hint}` : '未配置 —— 只能看盘'}
            </div>
          </div>

          <div className="field">
            <label>GATE_KEY</label>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="留空则不修改" spellCheck={false} />
          </div>
          <div className="field">
            <label>GATE_SECRET</label>
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="留空则不修改" spellCheck={false} />
          </div>

          <label className="toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span>
              允许下单（LIVE_TRADING）
              <span className="dim" style={{ display: 'block', fontSize: 10.5 }}>
                关掉以后服务端会拒绝一切下单、撤单、改杠杆请求，只能看盘。
              </span>
            </span>
          </label>

          <div className="hint" style={{ marginBottom: 12 }}>
            密钥只写进 <code>server/.env</code>，只有服务端读；页面拿到的永远只有尾号四位。
            到 Gate「API 管理」建密钥时勾选 <b>合约交易 · 读写</b> 就够，<b>不要开提现权限</b>。
          </div>

          {diag && (
            <div className="hint" style={{ padding: 9, border: '1px solid var(--line)', borderRadius: 6, marginBottom: 10 }}>
              <div>环境：{diag.envLabel} · <code>{diag.restBaseUrl}</code></div>
              <div>私有接口：{diag.privateOk ? <span className="up">正常</span> : <span className="down">{diag.privateError}</span>}</div>
              {diag.account && (
                <div style={{ marginTop: 4 }}>
                  总权益 {Number(diag.account.total ?? 0).toFixed(2)} · 可用 {Number(diag.account.available ?? 0).toFixed(2)} USDT
                </div>
              )}
            </div>
          )}

          <div className="row2">
            <button className="btn ghost" onClick={runDiag} disabled={busy}>接口体检</button>
            <button className="btn accent" onClick={save} disabled={busy}>{busy ? '处理中…' : '保存'}</button>
          </div>
        </div>
        <footer>
          <div className="hint">
            风控硬上限：单笔 {config?.limits.maxOrderNotional ?? '—'} USDT · 杠杆 ≤ {config?.limits.maxLeverage ?? '—'}x
            {config && config.limits.maxContracts > 0 ? ` · 单笔 ≤ ${config.limits.maxContracts} 张` : ''}
            （改上限请编辑 server/.env）
          </div>
        </footer>
      </div>
    </div>
  );
}
