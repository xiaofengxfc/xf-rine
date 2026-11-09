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
  // 两套密钥各存各的，互不覆盖：填实盘的不该把模拟盘那格冲掉
  const [testKey, setTestKey] = useState('');
  const [testSecret, setTestSecret] = useState('');
  const [liveKey, setLiveKey] = useState('');
  const [liveSecret, setLiveSecret] = useState('');
  const [live, setLive] = useState(config?.liveTrading ?? false);
  const [switching, setSwitching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiBase, setAiBase] = useState(config?.ai.baseUrl ?? '');
  const [aiModel, setAiModel] = useState(config?.ai.model ?? '');
  const [aiKey, setAiKey] = useState('');
  const [clearAiKey, setClearAiKey] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const cur = config?.env ?? 'testnet';
      const other = cur === 'testnet' ? 'live' : 'testnet';
      const curKey = cur === 'testnet' ? testKey : liveKey;
      const curSecret = cur === 'testnet' ? testSecret : liveSecret;
      const otherKey = other === 'testnet' ? testKey : liveKey;
      const otherSecret = other === 'testnet' ? testSecret : liveSecret;

      const aiPayload: Record<string, unknown> = {};
      if (aiBase.trim()) aiPayload.aiBaseUrl = aiBase.trim();
      if (aiModel.trim()) aiPayload.aiModel = aiModel.trim();
      // 密钥留空表示不改；点过「清除」才真的写空
      if (aiKey.trim()) aiPayload.aiApiKey = aiKey.trim();
      else if (clearAiKey) aiPayload.aiApiKey = '';

      // 第一笔带上当前环境的密钥和全局开关，第二笔只写另一格（填了才发）
      const first: Record<string, unknown> = { slotEnv: cur, liveTrading: live, ...aiPayload };
      if (curKey.trim()) first.key = curKey.trim();
      if (curSecret.trim()) first.secret = curSecret.trim();
      await jsend('POST', '/api/config/keys', first);

      if (otherKey.trim() || otherSecret.trim()) {
        const second: Record<string, unknown> = { slotEnv: other };
        if (otherKey.trim()) second.key = otherKey.trim();
        if (otherSecret.trim()) second.secret = otherSecret.trim();
        await jsend('POST', '/api/config/keys', second);
      }

      onToast('ok', '已写入 server/.env', '立即生效，不用重启');
      setTestKey(''); setTestSecret(''); setLiveKey(''); setLiveSecret('');
      setAiKey(''); setClearAiKey(false);
      onSaved();
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    } finally { setBusy(false); }
  }

  /** 切环境是个独立动作：它决定钱从哪个账户出，不该夹在「保存密钥」里 */
  async function switchEnv(next: 'testnet' | 'live') {
    if (next === config?.env) return;
    setSwitching(true);
    try {
      const r = await jsend<{ env: string; envLabel: string; liveTrading: boolean }>('POST', '/api/config/env', { env: next });
      setLive(r.liveTrading);
      onToast('ok', '已切换到' + r.envLabel, '下单开关已自动关闭，要交易得重新打开');
      onSaved();
    } catch (e) {
      onToast('err', '切换失败', (e as Error).message);
    } finally { setSwitching(false); }
  }

  async function loadModels() {
    setLoadingModels(true);
    try {
      const r = await jsend<{ models: string[] }>('POST', '/api/ai/models', {
        baseUrl: aiBase.trim() || undefined,
        apiKey: aiKey.trim() || undefined,
      });
      setModels(r.models);
      if (!aiModel.trim() && r.models[0]) setAiModel(r.models[0]);
      onToast('ok', '拿到 ' + r.models.length + ' 个模型', '点模型名旁边的输入框就能选');
    } catch (e) {
      const err = e as Error & { label?: string };
      // 拉不到不是错误状态，很多中转站根本没这个接口 —— 照样能手填
      onToast('err', '拉不到模型列表', `${err.label ?? ''} ${err.message}`.trim() + '（直接填名字也可以）');
    } finally { setLoadingModels(false); }
  }

  async function testAi() {
    setTesting(true);
    try {
      const r = await jsend<{ ok: boolean; model: string; ms: number; endpoint: string }>('POST', '/api/ai/test', {
        baseUrl: aiBase.trim() || undefined,
        apiKey: aiKey.trim() || undefined,
        model: aiModel.trim() || undefined,
      });
      onToast('ok', 'AI 接口连通', `${r.endpoint} · ${r.model} · ${r.ms}ms`);
    } catch (e) {
      const err = e as Error & { label?: string };
      onToast('err', 'AI 接口不通', `${err.label ?? ''} ${err.message}`.trim());
    } finally { setTesting(false); }
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
            <label>当前环境</label>
            <div className="seg" style={{ width: '100%' }}>
              <button className={config?.env === 'testnet' ? 'on' : ''} onClick={() => switchEnv('testnet')} disabled={switching} style={{ flex: 1 }}>模拟盘</button>
              <button
                className={config?.env === 'live' ? 'on' : ''}
                onClick={() => switchEnv('live')}
                disabled={switching}
                style={{ flex: 1, color: config?.env === 'live' ? 'var(--down)' : undefined }}
              >实盘</button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              模拟盘打 <code>api-testnet.gateapi.io</code>（假钱），实盘打 <code>api.gateio.ws</code>（真钱）。
              切换立即生效，并且会顺手关掉下单开关。行情两种环境都连主网。
            </div>
          </div>

          <div className="field">
            <label>模拟盘密钥</label>
            <div className="hint" style={{ fontFamily: 'var(--mono)', marginBottom: 6 }}>
              {config?.keysByEnv.testnet.configured
                ? `已配置 ${config.keysByEnv.testnet.hint}`
                : '未配置'}
            </div>
            <input className="input" value={testKey} onChange={(e) => setTestKey(e.target.value)} placeholder="GATE_TESTNET_KEY，留空不改" spellCheck={false} />
            <input className="input" type="password" value={testSecret} onChange={(e) => setTestSecret(e.target.value)} placeholder="GATE_TESTNET_SECRET，留空不改" spellCheck={false} style={{ marginTop: 6 }} />
          </div>

          <div className="field">
            <label>实盘密钥</label>
            <div className="hint" style={{ fontFamily: 'var(--mono)', marginBottom: 6 }}>
              {config?.keysByEnv.live.configured
                ? `已配置 ${config.keysByEnv.live.hint}`
                : '未配置'}
            </div>
            <input className="input" value={liveKey} onChange={(e) => setLiveKey(e.target.value)} placeholder="GATE_LIVE_KEY，留空不改" spellCheck={false} />
            <input className="input" type="password" value={liveSecret} onChange={(e) => setLiveSecret(e.target.value)} placeholder="GATE_LIVE_SECRET，留空不改" spellCheck={false} style={{ marginTop: 6 }} />
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

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', color: 'var(--text-2)', marginBottom: 9 }}>
              AI 分析模型
            </div>
            <div className="hint" style={{ marginBottom: 9 }}>
              任何 OpenAI 兼容接口都能用：官方地址、中转站、本地 Ollama 都可以。
              地址填到 <code>/v1</code> 就行，服务端会自己补后面的路径；填完整路径也认。
              当前状态：{config?.ai.configured ? <>已配置 <code>{config.ai.hint}</code></> : '未配置'}
            </div>

            <div className="field">
              <label>接口地址</label>
              <input
                className="input"
                value={aiBase}
                onChange={(e) => setAiBase(e.target.value)}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>模型名</label>
              <input
                className="input"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                placeholder="gpt-4o-mini"
                spellCheck={false}
                list={models.length > 0 ? 'ai-model-list' : undefined}
              />
              {models.length > 0 && (
                <datalist id="ai-model-list">
                  {models.map((m) => <option key={m} value={m} />)}
                </datalist>
              )}
              <button
                className="btn ghost"
                style={{ marginTop: 6, width: '100%' }}
                onClick={loadModels}
                disabled={busy || loadingModels}
              >
                {loadingModels ? '拉取中…' : models.length > 0 ? `已拉到 ${models.length} 个 · 重新拉取` : '从接口拉取模型列表'}
              </button>
              <div className="hint" style={{ marginTop: 4 }}>
                拉取用的是上面填的地址和密钥，没保存也能拉。站点不支持这个接口的话直接填名字。
              </div>
            </div>
            <div className="field">
              <label>API 密钥</label>
              <input
                className="input"
                type="password"
                value={aiKey}
                onChange={(e) => { setAiKey(e.target.value); setClearAiKey(false); }}
                placeholder={clearAiKey ? '保存后会被清除' : '留空则不修改'}
                spellCheck={false}
              />
            </div>

            <div className="row2">
              <button className="btn ghost" onClick={testAi} disabled={busy || testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button
                className="btn ghost"
                onClick={() => { setAiKey(''); setClearAiKey(true); }}
                disabled={busy || !config?.ai.configured}
              >
                清除密钥
              </button>
            </div>
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
            风控硬上限：杠杆 ≤ {config?.limits.maxLeverage ?? '—'}x
            {config && config.limits.maxContracts > 0 ? ` · 单笔 ≤ ${config.limits.maxContracts} 张` : ''}
            （改上限请编辑 server/.env）
          </div>
        </footer>
      </div>
    </div>
  );
}
