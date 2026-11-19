import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { jget, jsend, type AppConfig, type IpInfo } from '../lib/api.ts';
import { detectBrowserIp } from '../lib/ip.ts';
import { isNative, apiBase, clearTarget } from '../lib/endpoint.ts';
import { setTheme, useTheme } from '../lib/theme.ts';

type FeedbackKind = 'bug' | 'idea' | 'other';

/** 三种反馈的标签。顺序就是按钮顺序 */
const FB_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: '功能异常',
  idea: '功能建议',
  other: '其他',
};

interface Props {
  config: AppConfig | null;
  /** 反馈里要带上「当时在看哪个币、哪个周期」，排问题时最有用的一项 */
  contract?: string;
  interval?: string;
  onClose: () => void;
  onSaved: () => void;
  onToast: (kind: 'ok' | 'err', title: string, detail?: string) => void;
}

interface Diag {
  exchange?: 'gate' | 'bitget';
  exchangeLabel?: string;
  env: 'testnet' | 'live';
  envLabel: string;
  restBaseUrl: string;
  keys: { configured: boolean; hint: string };
  liveTrading: boolean;
  privateOk?: boolean;
  privateError?: string;
  account?: Record<string, string>;
}

type Tab = 'testnet' | 'live' | 'ai' | 'theme' | 'backup' | 'feedback';

interface EnvInfo {
  label: string;
  host: string;
  keyVar: string;
  secretVar: string;
  /** Bitget 有第三把钥匙；Gate 没有这一项 */
  passVar?: string;
  money: string;
}

/**
 * 两家交易所的地址和变量名，按「交易所 → 环境」两层。
 *
 * 写死一份 Gate 的话，切到 Bitget 之后这一页会把人指去填 GATE_LIVE_KEY，
 * 填完当然是"没配密钥"。
 */
const EX_INFO: Record<'gate' | 'bitget', Record<'testnet' | 'live', EnvInfo>> = {
  gate: {
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
  },
  bitget: {
    testnet: {
      label: '模拟盘',
      host: 'api.bitget.com（请求头带 PAPTRADING）',
      keyVar: 'BITGET_TESTNET_KEY',
      secretVar: 'BITGET_TESTNET_SECRET',
      passVar: 'BITGET_TESTNET_PASSPHRASE',
      money: '模拟账户的假钱',
    },
    live: {
      label: '实盘',
      host: 'api.bitget.com',
      keyVar: 'BITGET_LIVE_KEY',
      secretVar: 'BITGET_LIVE_SECRET',
      passVar: 'BITGET_LIVE_PASSPHRASE',
      money: '真钱',
    },
  },
};

export default function SettingsDialog({ config, contract = '', interval = '', onClose, onSaved, onToast }: Props) {
  const [tab, setTab] = useState<Tab>(config?.env ?? 'testnet');
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);
  // 两套密钥各存各的，互不覆盖：填实盘的不该把模拟盘那格冲掉
  const [testKey, setTestKey] = useState('');
  const [testSecret, setTestSecret] = useState('');
  // Bitget 的 passphrase：创建 API 时自己设的那串口令
  const [testPass, setTestPass] = useState('');
  const [liveKey, setLiveKey] = useState('');
  const [liveSecret, setLiveSecret] = useState('');
  const [livePass, setLivePass] = useState('');
  const [live, setLive] = useState(config?.liveTrading ?? false);
  const [switching, setSwitching] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  /** 备份：导出用的密码（两遍）和导入用的密码各存各的，免得来回改 */
  const [bkPass, setBkPass] = useState('');
  const [bkPass2, setBkPass2] = useState('');
  const [bkBusy, setBkBusy] = useState(false);
  /** 刚导出的密文，方便手机上没有下载目录时直接复制 */
  const [bkCipher, setBkCipher] = useState('');
  const [bkImportPass, setBkImportPass] = useState('');
  const [bkImportText, setBkImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiBase, setAiBase] = useState(config?.ai.baseUrl ?? '');
  const [aiModel, setAiModel] = useState(config?.ai.model ?? '');
  const [aiKey, setAiKey] = useState('');
  const [clearAiKey, setClearAiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  /** 当前 IP：浏览器自己问出来的，含系统代理和 VPN */
  const [ip, setIp] = useState<IpInfo | null>(null);
  /** 服务端直连出去的地址，和上面那个常常不是一个 */
  const [serverIp, setServerIp] = useState<IpInfo | null>(null);
  const [ipBusy, setIpBusy] = useState(false);
  /** 窄屏顶栏藏了主题开关，这一页是手机上唯一的入口，所以深色浅色都放全 */
  const theme = useTheme();

  // ---- 反馈 ----
  const [fbKind, setFbKind] = useState<FeedbackKind>('bug');
  const [fbTitle, setFbTitle] = useState('');
  const [fbBody, setFbBody] = useState('');
  const [fbContact, setFbContact] = useState('');
  const [fbSending, setFbSending] = useState(false);
  /** 从服务端拿到的收件信箱：内嵌在服务端，页面只负责显示，不给改 */
  const fbTo = config?.feedback?.to ?? '';

  const currentEnv = config?.env ?? 'testnet';
  /** 手机要填的那两行。口令只有在本机打开页面时才带回来 */
  const native = isNative();
  const lanUrl = config?.remote?.urls[0] ?? '';

  /** 只保存这个环境自己那一格的密钥，绝不碰 GATE_ENV */
  async function saveEnv(env: 'testnet' | 'live') {
    const k = env === 'testnet' ? testKey : liveKey;
    const s = env === 'testnet' ? testSecret : liveSecret;
    const p = env === 'testnet' ? testPass : livePass;
    if (!k.trim() && !s.trim() && !p.trim() && env !== currentEnv) {
      onToast('err', '没有要保存的内容', '至少填一项，留空表示不改');
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { slotEnv: env };
      if (k.trim()) payload.key = k.trim();
      if (s.trim()) payload.secret = s.trim();
      if (p.trim()) payload.passphrase = p.trim();
      // 下单开关是全局的，只在当前环境这一页跟着改，免得在另一页顺手把它打开
      if (env === currentEnv) payload.liveTrading = live;
      await jsend('POST', '/api/config/keys', payload);
      onToast('ok', EX_INFO[config?.exchange ?? 'gate'][env].label + '密钥已保存', '立即生效，不用重启');
      if (env === 'testnet') { setTestKey(''); setTestSecret(''); setTestPass(''); }
      else { setLiveKey(''); setLiveSecret(''); setLivePass(''); }
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

  /**
   * 两路一起问：
   *   1. 浏览器自己问 —— 走系统代理和 VPN，这才是「当前 IP」；
   *   2. 服务端 /api/ip —— Node 直连出去的地址，Gate 的 API 请求从那里发出。
   * 两者不一样时把服务端那个也写出来，白名单才不会填错。
   */
  /** 后发先至的那一次才作数：进页面自动问一次，紧接着点「重新检测」会两个请求并行 */
  const ipSeq = useRef(0);
  const loadIp = useCallback(async (fresh: boolean): Promise<IpInfo> => {
    const seq = ++ipSeq.current;
    setIpBusy(true);
    try {
      // 手机上「浏览器 IP」是手机自己的，拿它填白名单等于把交易挡在门外，
      // 所以手机端只问服务端那一条 —— Gate 看到的是电脑的出口地址。
      const [browser, server] = await Promise.all([
        isNative() ? Promise.resolve(null) : detectBrowserIp(),
        jget<IpInfo>('/api/ip' + (fresh ? '?fresh=1' : ''), { cache: 'no-store' }).catch(() => null),
      ]);
      if (seq !== ipSeq.current) return (browser ?? server ?? { ok: false, ip: '', at: Date.now(), error: '没查到' }) as IpInfo;
      setIp(browser);
      setServerIp(server);
      // 调用方拿这个去弹提示，说清楚「抄的是哪一个」
      return (browser ?? server ?? { ok: false, ip: '', at: Date.now(), error: '没查到' }) as IpInfo;
    } finally {
      if (seq === ipSeq.current) setIpBusy(false);
    }
  }, []);

  // 每次进实盘这一页都重新要一次。服务端 60 秒内给缓存，点开就是秒回
  useEffect(() => {
    if (tab !== 'live') return;
    void loadIp(false);
  }, [tab, loadIp]);

  async function copyText(text: string, okTitle: string) {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // 走局域网地址打开时不是安全上下文，clipboard 用不了，退回老办法
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        // execCommand 失败只返回 false，不抛异常：不认返回值就会在「其实没复制上」的时候
        // 报一句「已复制」，用户粘出来的是上一次剪贴板里的东西
        if (!ok) {
          onToast('err', '复制失败', '手动选中那串字复制');
          return;
        }
      }
      onToast('ok', okTitle, text);
    } catch {
      onToast('err', '复制失败', '手动选中那串字复制');
    }
  }

  async function copyIp() {
    const src = native ? serverIp : ip;
    if (!src?.ok || !src.ip) return;
    await copyText(src.ip, 'IP 已复制');
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

  /**
   * 换交易所。
   *
   * 这不是「换一个数据源」，是换一个账户：合约名、张数口径、持仓、挂单全变了。
   * 服务端会顺手清掉解锁令牌、停掉 AI 交易、关掉下单开关，所以这里只说清楚发生了什么。
   */
  async function switchExchange(next: 'gate' | 'bitget') {
    if (next === (config?.exchange ?? 'gate')) return;
    setSwitching(true);
    try {
      const r = await jsend<{ exchangeLabel: string }>('POST', '/api/config/exchange', { exchange: next });
      setLive(false);
      onToast('ok', '已切换到 ' + r.exchangeLabel, '下单开关和 AI 交易已自动关闭；密钥要按这一家的重填');
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

  /**
   * 发反馈。
   *
   * 校验放在前面：标题两个字的空信发出去，收到的只有一句「不好用」，
   * 来回问一轮不如当场拦下来。
   */
  async function sendFeedback() {
    const title = fbTitle.trim();
    const text = fbBody.trim();
    if (title.length < 2) { onToast('err', '标题太短', '至少写两个字，说清是什么问题'); return; }
    if (text.length < 5) { onToast('err', '内容太短', '把当时的情况写下来再发'); return; }
    setFbSending(true);
    try {
      const r = await jsend<{ ok: boolean; to: string; at: number }>('POST', '/api/feedback', {
        kind: fbKind,
        title,
        body: text,
        contact: fbContact.trim(),
        // 服务端只认这几个键，别的字段会被丢掉
        extra: {
          合约: contract,
          周期: interval,
          窗口: `${window.innerWidth}×${window.innerHeight}`,
          页面: navigator.userAgent,
        },
      });
      setFbTitle('');
      setFbBody('');
      setFbContact('');
      onToast('ok', '反馈已发出', '寄到 ' + r.to + '，谢谢');
    } catch (e) {
      const err = e as Error & { label?: string };
      onToast('err', '没发出去', `${err.label ?? ''} ${err.message}`.trim() + ' —— 也可以点「复制信箱」手动发');
    } finally {
      setFbSending(false);
    }
  }

  /**
   * 导出备份。
   *
   * 页面这一侧只负责把 localStorage 收齐交给服务端：加密在服务端做 —— 手机用局域网 IP
   * 打开页面时不是安全上下文，浏览器根本没有 crypto.subtle，放在页面里手机上就用不了。
   */
  async function exportBackup() {
    if (bkPass.length < 8) { onToast('err', '密码太短', '至少 8 位。这个文件里放着 API 密钥'); return; }
    if (bkPass !== bkPass2) { onToast('err', '两次密码不一样'); return; }
    const local: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('xf-rine:')) continue;
      local[k] = localStorage.getItem(k) ?? '';
    }
    setBkBusy(true);
    try {
      const r = await jsend<{ envelope: unknown; counts: { env: number; strategies: number; local: number } }>(
        'POST', '/api/backup/export', { password: bkPass, local },
      );
      const text = JSON.stringify(r.envelope, null, 2);
      setBkCipher(text);
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xunfeng-' + stamp + '.xfbackup.json';
      a.click();
      URL.revokeObjectURL(url);
      onToast('ok', '备份已导出', r.counts.env + ' 项配置 · ' + r.counts.strategies + ' 条策略 · ' + r.counts.local + ' 项页面设置');
      setBkPass('');
      setBkPass2('');
    } catch (e) {
      onToast('err', '导出失败', (e as Error).message);
    } finally { setBkBusy(false); }
  }

  /**
   * 恢复。
   *
   * 服务端把文件写回去之后页面必须重载：内存里那份旧配置（币种、密钥尾号、
   * 交易所）已经不成立了，不重载会看到一半新一半旧。
   */
  async function importBackup(text: string) {
    if (!bkImportPass) { onToast('err', '要填密码'); return; }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      onToast('err', '这不是备份文件', '选一个 .xfbackup.json，或者把里面的内容粘进来');
      return;
    }
    setBkBusy(true);
    try {
      const r = await jsend<{ applied: string[]; local: Record<string, string> }>(
        'POST', '/api/backup/import', { password: bkImportPass, envelope },
      );
      for (const [k, v] of Object.entries(r.local ?? {})) {
        try { localStorage.setItem(k, v); } catch { /* 配额满了就算了 */ }
      }
      onToast('ok', '已恢复', (r.applied.join('、') || '没有可恢复的内容') + '。页面马上重新加载');
      setBkImportPass('');
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      onToast('err', '恢复失败', (e as Error).message);
    } finally { setBkBusy(false); }
  }

  function envTab(env: 'testnet' | 'live') {
    const ex = config?.exchange ?? 'gate';
    const exName = config?.exchangeLabel ?? (ex === 'bitget' ? 'Bitget' : 'Gate');
    const info = EX_INFO[ex][env];
    const isCurrent = env === currentEnv;
    const state = config?.keysByEnv?.[env];
    const k = env === 'testnet' ? testKey : liveKey;
    const s = env === 'testnet' ? testSecret : liveSecret;
    const p = env === 'testnet' ? testPass : livePass;
    const setK = env === 'testnet' ? setTestKey : setLiveKey;
    const setS = env === 'testnet' ? setTestSecret : setLiveSecret;
    const setP = env === 'testnet' ? setTestPass : setLivePass;

    return (
      <>
        <div className="hint" style={{ marginBottom: 12 }}>
          {isCurrent ? (
            <>这是<b>当前环境</b>，打 <code>{info.host}</code>，下单用的是{info.money}。</>
          ) : (
            <>这是<b>另一套密钥</b>，存在 <code>{info.keyVar}</code> 那一格。保存它<b>不会</b>把程序切到这个环境。</>
          )}
        </div>

        {env === 'live' && (
          <div className="field">
            <label className="ip-label">
              <span>当前 IP</span>
              <button
                className="link-btn"
                onClick={() => {
                  // 手动点的这次一定真的去问，问完把结果说出来 —— 否则 IP 没变就什么反馈都没有
                  void loadIp(true).then((r) => {
                    onToast(r.ok ? 'ok' : 'err', r.ok ? '已重新检测' : '检测失败', r.ok ? r.ip : r.error);
                  });
                }}
                disabled={ipBusy}
                title="换了网络或代理之后点这里"
              >
                {ipBusy ? '检测中…' : '重新检测'}
              </button>
            </label>
            <div className="ip-row">
              <input
                className="input"
                readOnly
                spellCheck={false}
                value={(native ? serverIp : ip)?.ok ? (native ? serverIp : ip)?.ip ?? '' : ''}
                placeholder={ipBusy ? '检测中…' : '没检测到'}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="btn ghost ip-copy" onClick={copyIp} disabled={!(native ? serverIp : ip)?.ok}>复制</button>
            </div>
            <div className="hint mono ip-meta">
              <span className="ip-geo">
                {(native ? serverIp : ip)?.ok
                  ? [
                      (native ? serverIp : ip)?.country,
                      (native ? serverIp : ip)?.region,
                      (native ? serverIp : ip)?.city,
                      // 运营商名字前面的 AS 号（AS9808 …）对填白名单没用，去掉
                      (native ? serverIp : ip)?.isp?.replace(/^AS\d+\s+/i, '') ?? '',
                    ].filter(Boolean).join(' · ')
                  : ((native ? serverIp : ip)?.error ?? '')}
              </span>
              {/* 检测时间：点了「重新检测」有没有真的重查，看这个 */}
              {(native ? serverIp : ip)?.ok && (
                <span className="ip-time">
                  检测于 {new Date((native ? serverIp : ip)!.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              )}
            </div>
            <div className="hint">
              {native
                ? '服务端就在这台手机上，所以这也是手机的网络出口地址 —— 白名单填它。换 Wi-Fi 或用流量时这个地址会变。'
                : '浏览器当前的地址，走代理或 VPN 时就是代理那边的。'}
              {serverIp?.proxy?.on && (
                <>
                  {' '}服务端查 IP 也走系统代理（<code>{serverIp.proxy.url}</code>）。
                  {exName} 的行情和交易直连，直连不通才退回代理，白名单填{' '}
                  <code>{serverIp.directIp ?? serverIp.ip}</code>。
                </>
              )}
              {serverIp?.proxy && !serverIp.proxy.on && serverIp.ok && (!ip?.ok || serverIp.ip !== ip.ip) && (
                <> 服务端直连出口是 <code>{serverIp.ip}</code>，{exName} 的 API 请求从那里发出 —— 白名单要填这一个。</>
              )}
            </div>
          </div>
        )}

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
        {info.passVar && (
          <div className="field">
            <label>{info.passVar}</label>
            <input className="input" type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="留空表示不修改" spellCheck={false} />
            <div className="hint">
              Bitget 创建 API 时自己设的那串口令。它不在这里填，读账户和下单都会被拒
              （报「无效的 PASSPHRASE」），而密钥本身看着是配好的。
            </div>
          </div>
        )}

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
                <div>交易所：{diag.exchangeLabel ?? config?.exchangeLabel ?? 'Gate'} · 环境：{diag.envLabel} · <code>{diag.restBaseUrl}</code></div>
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
          密钥只写进服务端的 <code>{config?.envPath ?? 'server/.env'}</code>，只有服务端读；
          页面拿到的永远只有尾号四位。
          {ex === 'bitget' ? (
            <>
              到 Bitget「API 管理」建密钥时勾选 <b>合约交易 · 读写</b>，并把创建时设的口令
              （Passphrase）一起填上 —— <b>KEY / SECRET / PASSPHRASE 三样缺一不可</b>。
              <b>不要开提现权限</b>。
            </>
          ) : (
            <>到 Gate「API 管理」建密钥时勾选 <b>合约交易 · 读写</b> 就够，<b>不要开提现权限</b>。</>
          )}
        </div>

        {native && (
          <div className="hint" style={{ marginBottom: 12 }}>
            手机上整套程序都在本地跑，密钥也存在这台手机上（<code>{config?.envPath ?? 'App 私有目录'}</code>），
            和电脑那份互不相干。交易所如果开了 IP 白名单，要填的是<b>这台手机</b>的出口地址 —— 见实盘页那一格。
          </div>
        )}

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

        {/*
          交易所放在最上面：它决定下面这两格填的是哪一家的密钥。
          同一时间只连一家 —— 合约名、张数、持仓、挂单的整套口径都绑在这一个选择上。
        */}
        <div className="ex-pick" style={{ marginBottom: 12 }}>
          <div className="seg" style={{ width: '100%' }}>
            {(['gate', 'bitget'] as const).map((x) => (
              <button
                key={x}
                className={(config?.exchange ?? 'gate') === x ? 'on' : ''}
                style={{ flex: 1 }}
                disabled={switching}
                onClick={() => void switchExchange(x)}
              >
                {x === 'gate' ? 'Gate' : 'Bitget'}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            切换会关掉下单开关和 AI 交易（因为换的是另一个账户），两家的密钥各存各的。
          </div>
        </div>

        {/* 五格之后每格只剩七十来像素，所以「当前环境」只留一个小点，文字留给标签自己 */}
        <div className="set-tabs">
          <button className={tab === 'testnet' ? 'on' : ''} onClick={() => setTab('testnet')}>
            模拟盘{currentEnv === 'testnet' && <i className="tab-dot" title="当前环境" />}
          </button>
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
            实盘{currentEnv === 'live' && <i className="tab-dot" title="当前环境" />}
          </button>
          <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>AI</button>
          <button className={tab === 'theme' ? 'on' : ''} onClick={() => setTab('theme')}>外观</button>
          <button className={tab === 'backup' ? 'on' : ''} onClick={() => setTab('backup')}>备份</button>
          <button className={tab === 'feedback' ? 'on' : ''} onClick={() => setTab('feedback')}>反馈</button>
        </div>

        <div className="body" ref={bodyRef}>
          {(tab === 'testnet' || tab === 'live') && envTab(tab)}

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

              <div className="field" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <label>{native ? '数据目录' : '手机访问'}</label>
                {native ? (
                  <div className="hint">
                    密钥和设置存在 <code>{config?.envPath ?? 'App 私有目录'}</code>。
                    这是 App 自己的目录，卸载 App 才会跟着没；电脑上那一份是另一套，两个互不覆盖。
                  </div>
                ) : config?.remote?.enabled ? (
                  <>
                    <div className="ip-row">
                      <input
                        className="input mono"
                        readOnly
                        spellCheck={false}
                        value={lanUrl}
                        placeholder="没找到局域网地址（电脑没连 Wi-Fi？）"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button className="btn ghost ip-copy" onClick={() => void copyText(lanUrl, '地址已复制')} disabled={!lanUrl}>
                        复制
                      </button>
                    </div>
                    <div className="ip-row" style={{ marginTop: 8 }}>
                      <input
                        className="input mono"
                        readOnly
                        spellCheck={false}
                        value={config.remote.token ?? ''}
                        placeholder="没设口令"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        className="btn ghost ip-copy"
                        onClick={() => void copyText(config.remote?.token ?? '', '口令已复制')}
                        disabled={!config.remote.token}
                      >
                        复制
                      </button>
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>
                      手机 App 里填上面两行，同一个 Wi-Fi 才能连上。口令是这一台服务端的钥匙，
                      谁拿到谁就能下单，别随手发出去。
                      第一次启动时 Windows 会弹防火墙，要选「允许专用网络访问」，否则手机连不进来。
                    </div>
                  </>
                ) : (
                  <div className="hint">
                    服务端现在只听本机（<code>HOST=127.0.0.1</code>），手机连不进来。
                    桌面安装版第一次启动会自动打开这一项；
                    手动跑源码的话，在 <code>{config?.envPath ?? 'server/.env'}</code> 里加两行
                    {' '}<code>HOST=0.0.0.0</code> 和 <code>REMOTE_TOKEN=一串自己定的口令</code>，
                    重启服务后回来这里就有地址了。
                  </div>
                )}
              </div>

              {native && (
                <div className="field">
                  <label>当前连的服务端</label>
                  <div className="hint mono">{apiBase() || '（同源）'}</div>
                  <button
                    className="btn ghost"
                    style={{ width: '100%', marginTop: 6 }}
                    onClick={() => { clearTarget(); location.reload(); }}
                  >
                    换一台电脑
                  </button>
                </div>
              )}
            </>
          )}
          {tab === 'theme' && (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                主题记在这台设备上：电脑和手机各选各的，不会互相覆盖。
              </div>

              <div className="seg" style={{ width: '100%' }}>
                <button className={theme === 'dark' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTheme('dark')}>
                  深色
                </button>
                <button className={theme === 'light' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTheme('light')}>
                  浅色
                </button>
              </div>

              <div className="hint" style={{ marginTop: 10 }}>
                点了立刻生效，不用重启。浅色下 K 线的底色、网格、坐标轴会一起换，
                涨跌色和画线颜色保持不变。
              </div>
            </>
          )}

          {tab === 'backup' && (
            <>
              <div className="hint" style={{ marginBottom: 12 }}>
                备份是一个<b>加密文件</b>：两家的密钥、策略库、AI 交易设置、画线和偏好都在里面。
                <b>密码丢了就打不开</b>，谁也找不回来。
                恢复会覆盖这台机器现在的配置（被覆盖的文件各留一份 <code>.bak</code>），恢复完页面会重新加载。
              </div>

              <div className="field">
                <label>导出 · 设置密码（至少 8 位）</label>
                <input
                  className="input" type="password" spellCheck={false}
                  value={bkPass} onChange={(e) => setBkPass(e.target.value)}
                  placeholder="这个密码不存进任何地方，只用来加密这个文件"
                />
              </div>
              <div className="field">
                <label>再输一次</label>
                <input
                  className="input" type="password" spellCheck={false}
                  value={bkPass2} onChange={(e) => setBkPass2(e.target.value)}
                />
              </div>
              <div className="row4" style={{ marginBottom: 14 }}>
                <button className="btn" disabled={bkBusy} onClick={() => void exportBackup()}>
                  {bkBusy ? '处理中…' : '导出并下载'}
                </button>
                {bkCipher && (
                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard?.writeText(bkCipher);
                      onToast('ok', '已复制备份文本', '手机上没有下载目录时，把它存到别处再导入');
                    }}
                  >
                    复制备份文本
                  </button>
                )}
              </div>

              <div className="field">
                <label>恢复 · 选备份文件</label>
                <input
                  className="input"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text()
                      .then((t) => setBkImportText(t))
                      .catch(() => onToast('err', '读不了这个文件'));
                  }}
                />
              </div>
              <div className="field">
                <label>或者把备份内容粘进来</label>
                <textarea
                  className="input" rows={3} spellCheck={false}
                  value={bkImportText} onChange={(e) => setBkImportText(e.target.value)}
                  placeholder='{"format":"xf-rine-backup", …}'
                />
              </div>
              <div className="field">
                <label>这个备份的密码</label>
                <input
                  className="input" type="password" spellCheck={false}
                  value={bkImportPass} onChange={(e) => setBkImportPass(e.target.value)}
                />
              </div>
              <button className="btn" disabled={bkBusy || !bkImportText} onClick={() => void importBackup(bkImportText)}>
                恢复这份备份
              </button>
            </>
          )}

          {tab === 'feedback' && (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                说清楚「在做什么、看到什么、本来该是什么样」，比一句「用不了」有用得多。
                反馈由服务端用这个信箱直接寄出，不经过任何表单服务。
              </div>

              <div className="fb-mail">
                <span>收件信箱</span>
                <code>{fbTo || '（服务端还没配好）'}</code>
                {fbTo && (
                  <button className="link-btn" onClick={() => void copyText(fbTo, '信箱已复制')}>复制</button>
                )}
              </div>

              <div className="fb-kinds">
                {(Object.keys(FB_KIND_LABEL) as FeedbackKind[]).map((k) => (
                  <button key={k} className={`fb-kind${fbKind === k ? ' on' : ''}`} onClick={() => setFbKind(k)}>
                    {FB_KIND_LABEL[k]}
                  </button>
                ))}
              </div>

              <div className="field">
                <label>标题</label>
                <input
                  className="input"
                  value={fbTitle}
                  maxLength={80}
                  onChange={(e) => setFbTitle(e.target.value)}
                  placeholder="一句话说清问题"
                  spellCheck={false}
                />
              </div>

              <div className="field">
                <label>详细描述</label>
                <textarea
                  className="textarea"
                  value={fbBody}
                  maxLength={4000}
                  onChange={(e) => setFbBody(e.target.value)}
                  placeholder="做了什么操作、看到了什么、期望是什么。涉及下单的话把币种和方向也写上。"
                  spellCheck={false}
                />
                <div className="fb-meta">
                  <span>至少 5 个字</span>
                  <span>{fbBody.length}/4000</span>
                </div>
              </div>

              <div className="field">
                <label>联系方式（选填）</label>
                <input
                  className="input"
                  value={fbContact}
                  maxLength={120}
                  onChange={(e) => setFbContact(e.target.value)}
                  placeholder="邮箱或微信，想收回信就填"
                  spellCheck={false}
                />
              </div>

              <div className="fb-acts">
                <button className="btn ghost" onClick={() => void copyText(fbTo, '信箱已复制')} disabled={!fbTo}>
                  复制信箱
                </button>
                <button
                  className="btn accent"
                  onClick={() => void sendFeedback()}
                  disabled={fbSending || fbTitle.trim().length < 2 || fbBody.trim().length < 5}
                >
                  {fbSending ? '发送中…' : '发送反馈'}
                </button>
              </div>

              <div className="hint" style={{ marginTop: 9 }}>
                发送时会顺手带上当前环境（合约、周期、窗口大小、系统版本），
                这些只用来定位问题，不会带任何密钥。
                {!config?.feedback?.ready && ' 服务端还没配好发件信箱，这一页暂时发不出去。'}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
