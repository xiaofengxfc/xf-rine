import { useEffect, useRef, useState } from 'react';
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

type Tab = 'testnet' | 'live' | 'ai';

const ENV_INFO: Record<'testnet' | 'live', { label: string; host: string; keyVar: string; secretVar: string; money: string }> = {
  testnet: {
    label: '模拟盘',
    host: 'api-testnet.gateapi.io',
    keyVar: 'GATE_TESTNET_KEY',
    secretVar: 'GATE_TESTNET_SECRET',
    money: '测试网的假钱',
  },
  live: {
    label: '实盘',
    host: 'api.gateio.ws',
    keyVar: 'GATE_LIVE_KEY',
    secretVar: 'GATE_LIVE_SECRET',
    money: '真钱',
  },
};

export default function SettingsDialog({ config, onClose, onSaved, onToast }: Props) {
  const [tab, setTab] = useState<Tab>(config?.env ?? 'testnet');
  // 两套密钥各存各的，互不覆盖：填实盘的不该把模拟盘那格冲掉
  const [testKey, setTestKey] = useState('');
  const [testSecret, setTestSecret] = useState('');
  const [liveKey, setLiveKey] = useState('');
  const [liveSecret, setLiveSecret] = useState('');
  const [live, setLive] = useState(config?.liveTrading ?? false);
  const [switching, setSwitching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiBase, setAiBase] = useState(config?.ai.baseUrl ?? '');
  const [aiModel, setAiModel] = useState(config?.ai.model ?? '');
  const [aiKey, setAiKey] = useState('');
  const [clearAiKey, setClearAiKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const currentEnv = config?.env ?? 'testnet';

  /** 只保存这个环境自己那一格的密钥，绝不碰 GATE_ENV */
  async function saveEnv(env: 'testnet' | 'live') {
    const k = env === 'testnet' ? testKey : liveKey;
    const s = env === 'testnet' ? testSecret : liveSecret;
    if (!k.trim() && !s.trim() && env !== currentEnv) {
      onToast('err', '没有要保存的内容', '至少填一项，留空表示不改');
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { slotEnv: env };
      if (k.trim()) payload.key = k.trim();
      if (s.trim()) payload.secret = s.trim();
      // 下单开关是全局的，只在当前环境这一页跟着改，免得在另一页顺手把它打开
      if (env === currentEnv) payload.liveTrading = live;
      await jsend('POST', '/api/config/keys', payload);
      onToast('ok', ENV_INFO[env].label + '密钥已保存', '立即生效，不用重启');
      if (env === 'testnet') { setTestKey(''); setTestSecret(''); } else { setLiveKey(''); setLiveSecret(''); }
      onSaved();
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function saveAi() {
    setBusy(true);
    try {
      const aiPayload: Record<string, unknown> = { slotEnv: currentEnv };
      if (aiBase.trim()) aiPayload.aiBaseUrl = aiBase.trim();
      if (aiModel.trim()) aiPayload.aiModel = aiModel.trim();
      // 密钥留空表示不改；点过「清除」才真的写空
      if (aiKey.trim()) aiPayload.aiApiKey = aiKey.trim();
      else if (clearAiKey) aiPayload.aiApiKey = '';
      await jsend('POST', '/api/config/keys', aiPayload);
      onToast('ok', 'AI 配置已保存', '立即生效，不用重启');
      setAiKey(''); setClearAiKey(false);
      onSaved();
    } catch (e) {
      onToast('err', '保存失败', (e as Error).message);
    } finally { setBusy(false); }
  }

  /** 切环境是个独立动作：它决定钱从哪个账户出，不该夹在保存里 */
  async function switchEnv(next: 'testnet' | 'live') {
    if (next === currentEnv) return;
    setSwitching(true);
    try {
      const r = await jsend<{ envLabel: string; liveTrading: boolean }>('POST', '/api/config/env', { env: next });
      setLive(r.liveTrading);
      onToast('ok', '已切换到' + r.envLabel, '下单开关已自动关闭，要交易得重新打开');
      onSaved();
    } catch (e) {
      onToast('err', '切换失败', (e as Error).message);
    } finally { setSwitching(false); }
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

  // 下拉开着的时候，点别处或按 Esc 收起来
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPickOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickOpen]);

  async function loadModels() {
    setLoadingModels(true);
    try {
      const r = await jsend<{ models: string[] }>('POST', '/api/ai/models', {
        baseUrl: aiBase.trim() || undefined,
        apiKey: aiKey.trim() || undefined,
      });
      setModels(r.models);
      if (!aiModel.trim() && r.models[0]) setAiModel(r.models[0]);
      onToast('ok', '拿到 ' + r.models.length + ' 个模型', '点模型名右边的 ▾ 就能选');
    } catch (e) {
      const err = e as Error & { label?: string };
      // 拉不到不是错误状态，很多中转站根本没这个接口 —— 照样能手填
      onToast('err', '拉不到模型列表', `${err.label ?? ''} ${err.message}`.trim() + '（直接填名字也可以）');
    } finally { setLoadingModels(false); }
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

  function envTab(env: 'testnet' | 'live') {
    const info = ENV_INFO[env];
    const isCurrent = env === currentEnv;
    const state = config?.keysByEnv?.[env];
    const k = env === 'testnet' ? testKey : liveKey;
    const s = env === 'testnet' ? testSecret : liveSecret;
    const setK = env === 'testnet' ? setTestKey : setLiveKey;
    const setS = env === 'testnet' ? setTestSecret : setLiveSecret;

    return (
      <>
        <div className="hint" style={{ marginBottom: 12 }}>
          {isCurrent ? (
            <>这是<b>当前环境</b>，打 <code>{info.host}</code>，下单用的是{info.money}。</>
          ) : (
            <>这是<b>另一套密钥</b>，存在 <code>{info.keyVar}</code> 那一格。保存它<b>不会</b>把程序切到这个环境。</>
          )}
        </div>

        <div className="field">
          <label>密钥状态</label>
          <div className="hint" style={{ fontFamily: 'var(--mono)' }}>
            {state?.configured ? `已配置 ${state.hint}` : '未配置 —— 只能看盘'}
          </div>
        </div>

        <div className="field">
          <label>{info.keyVar}</label>
          <input className="input" value={k} onChange={(e) => setK(e.target.value)} placeholder="留空表示不修改" spellCheck={false} />
        </div>
        <div className="field">
          <label>{info.secretVar}</label>
          <input className="input" type="password" value={s} onChange={(e) => setS(e.target.value)} placeholder="留空表示不修改" spellCheck={false} />
        </div>

        {isCurrent && (
          <>
            <label className="toggle" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              <span>
                允许下单（LIVE_TRADING）
                <span className="dim" style={{ display: 'block', fontSize: 10.5 }}>
                  关掉以后服务端会拒绝一切下单、撤单、改杠杆请求，只能看盘。
                </span>
              </span>
            </label>

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
          </>
        )}

        <div className="hint" style={{ marginBottom: 12 }}>
          密钥只写进 <code>server/.env</code>，只有服务端读；页面拿到的永远只有尾号四位。
          到 Gate「API 管理」建密钥时勾选 <b>合约交易 · 读写</b> 就够，<b>不要开提现权限</b>。
        </div>

        <div className="row2">
          {isCurrent ? (
            <button className="btn ghost" onClick={runDiag} disabled={busy || switching}>
              {busy ? '检测中…' : '接口体检'}
            </button>
          ) : (
            <button
              className="btn ghost"
              onClick={() => switchEnv(env)}
              disabled={busy || switching}
              style={env === 'live' ? { color: 'var(--down)' } : undefined}
            >
              {switching ? '切换中…' : '切到这个环境'}
            </button>
          )}
          <button className="btn accent" onClick={() => saveEnv(env)} disabled={busy}>
            {busy ? '处理中…' : '保存这套密钥'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <header>
          <h2>设置</h2>
          <button className="x" onClick={onClose}>×</button>
        </header>

        <div className="set-tabs">
          <button className={tab === 'testnet' ? 'on' : ''} onClick={() => setTab('testnet')}>
            模拟盘{currentEnv === 'testnet' ? ' ·当前' : ''}
          </button>
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
            实盘{currentEnv === 'live' ? ' ·当前' : ''}
          </button>
          <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>AI 与接口</button>
        </div>

        <div className="body">
          {tab !== 'ai' && envTab(tab)}

          {tab === 'ai' && (
            <>
              <div className="hint" style={{ marginBottom: 9 }}>
                任何 OpenAI 兼容接口都能用：官方地址、中转站、本地 Ollama 都可以。
                地址填到 <code>/v1</code> 就行，服务端会自己补后面的路径；填完整路径也认。
                当前状态：{config?.ai.configured ? <>已配置 <code>{config.ai.hint}</code></> : '未配置'}
              </div>

              <div className="field">
                <label>接口地址</label>
                <input className="input" value={aiBase} onChange={(e) => setAiBase(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
              </div>

              <div className="field">
                <label>模型名</label>
                <div className="model-pick" ref={pickRef}>
                  <input
                    className="input"
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    onFocus={() => { if (models.length > 0) setPickOpen(true); }}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                  />
                  {models.length > 0 && (
                    <button
                      className="model-arrow"
                      onClick={() => setPickOpen((v) => !v)}
                      title={`${models.length} 个模型，点开选`}
                      aria-label="选择模型"
                    >
                      ▾
                    </button>
                  )}
                  {pickOpen && models.length > 0 && (
                    <div className="model-list" role="listbox">
                      {models.map((m) => (
                        <button
                          key={m}
                          className={`model-item${m === aiModel ? ' on' : ''}`}
                          onClick={() => { setAiModel(m); setPickOpen(false); }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button className="btn ghost" style={{ marginTop: 6, width: '100%' }} onClick={loadModels} disabled={busy || loadingModels}>
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

              <div className="row2" style={{ marginBottom: 10 }}>
                <button className="btn ghost" onClick={testAi} disabled={busy || testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button className="btn ghost" onClick={() => { setAiKey(''); setClearAiKey(true); }} disabled={busy || !config?.ai.configured}>
                  清除密钥
                </button>
              </div>

              <button className="btn accent" style={{ width: '100%' }} onClick={saveAi} disabled={busy}>
                {busy ? '处理中…' : '保存 AI 配置'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
