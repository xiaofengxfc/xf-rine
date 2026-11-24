import { Router, type Request, type Response } from 'express';
import { bodyOf } from './http/params.js';
import {
  config, keyHint, keyHintFor, writeEnv, restBaseUrl, envLabel, keySlot, aiKeyHint, aiEndpoint,
  remoteAccess, ENV_PATH, exchangeLabel, exchangeIntervals, type GateEnv,
} from './config.js';
import { GateError } from './exchange/errors.js';
import { exchange, resetExchangeCache } from './exchange/index.js';
import { isLoopbackAddress } from './httpSecurity.js';
import { proxyState, refreshProxy, netFetch } from './net.js';
import { BackupError, applyBackupFiles, collectBackup, decryptBackup, encryptBackup, sanitizeLocal } from './backup.js';
import { listModels } from './ai.js';
import { sendFeedback, feedbackTarget, FeedbackError } from './feedback.js';
import { loadStrategy, saveStrategy } from './aiStrategy.js';

interface SystemRouteDeps {
  wrap: (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => void;
  requireLocal: (req: Request, what: string) => void;
  armTokens: Set<string>;
  stopAiRunner(): void;
}

export function mountSystemRoutes(router: Router, deps: SystemRouteDeps): void {
  const { wrap, requireLocal, armTokens, stopAiRunner } = deps;
  const keysByEnv = (): Record<GateEnv, { configured: boolean; hint: string }> => ({
    testnet: keyHintFor('testnet'),
    live: keyHintFor('live'),
  });
  // ---------- 配置与体检 ----------

  router.get('/config', (req, res) => {
    // 手机端要填的地址和口令。口令只回本机 —— 本机都打不开页面的话，也没有理由知道它。
    const remote = remoteAccess();
    const local = isLoopbackAddress(req.socket.remoteAddress ?? '');
    res.json({
      /**
       * 这个请求是不是从这台电脑上发出来的。
       *
       * 「选本地数据目录」读的是硬盘，服务端只认回环地址。前端以前靠自己看
       * window.location.hostname 猜 —— 可桌面壳（Electron 的 file:// 或 0.0.0.0）
       * 和局域网地址下，那个判断和真实来源根本对不上，按钮要么永远禁用、要么点了才 403。
       * 现在由服务端在这里说了算。
       */
      local,
      /** 现在连的是哪家。页面上的「Gate / Bitget」和周期列表都按它来 */
      exchange: config.exchange,
      exchangeLabel: exchangeLabel(),
      /** 这家支持哪些周期。Bitget 没有 8h，列出来点了只会报错 */
      intervals: exchangeIntervals(),
      env: config.env,
      envLabel: envLabel(),
      restBaseUrl: restBaseUrl(),
      keys: keyHint(),
      keysByEnv: keysByEnv(),
      liveTrading: config.liveTrading,
      // 密钥文件到底存在哪。桌面端不在 server/.env，页面上要能说对地方
      envPath: ENV_PATH,
      remote: { enabled: remote.enabled, urls: remote.urls, token: local ? remote.token : null },
      ai: {
        configured: aiKeyHint().configured,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        hint: aiKeyHint().hint,
        endpoint: aiEndpoint(),
      },
      armed: false,
      // 反馈寄到哪个信箱，页面要能说清楚 —— 内嵌配置，用户不用自己填
      feedback: feedbackTarget(),
    });
  });

  /**
   * 写密钥。slotEnv 指定写进哪一格：模拟盘和实盘各存各的，互不覆盖。
   * 这里只管密钥，绝不碰 GATE_ENV —— 填另一套密钥不该顺手把程序切到真钱上。
   */
  router.post('/config/keys', wrap(async (req, res) => {
    requireLocal(req, '写密钥');
    const { key, secret, passphrase, liveTrading, slotEnv } = bodyOf(req.body);
    const targetEnv: GateEnv = slotEnv === 'testnet' || slotEnv === 'live' ? slotEnv : config.env;
    const slot = keySlot(targetEnv);
    const patch: Record<string, string> = {};
    if (typeof key === 'string' && key.trim()) patch[slot.key] = key.trim();
    if (typeof secret === 'string' && secret.trim()) patch[slot.secret] = secret.trim();
    // Bitget 的第三把钥匙；Gate 用不到，传了也不写
    if (config.exchange === 'bitget' && typeof passphrase === 'string' && passphrase.trim()) {
      patch[slot.passphrase] = passphrase.trim();
    }
    if (typeof liveTrading === 'boolean') patch.LIVE_TRADING = liveTrading ? 'true' : 'false';
    // AI 三个字段各管各的：传了就写，字符串为空表示清除，不传就不动
    const { aiBaseUrl, aiApiKey, aiModel } = bodyOf(req.body);
    if (typeof aiBaseUrl === 'string' && aiBaseUrl.trim()) patch.AI_BASE_URL = aiBaseUrl.trim();
    if (typeof aiApiKey === 'string') patch.AI_API_KEY = aiApiKey.trim();
    if (typeof aiModel === 'string' && aiModel.trim()) patch.AI_MODEL = aiModel.trim();
    if (Object.keys(patch).length === 0) throw new GateError(400, 'EMPTY', '没有要写入的字段');
    // 关掉下单开关就是撤销所有已解锁的会话。否则重新打开开关时，
    // 十分钟前解锁的那个令牌还活着，等于开关白关了一次。
    if (typeof liveTrading === 'boolean' && !liveTrading) armTokens.clear();
    writeEnv(patch);
    res.json({
      ok: true,
      exchange: config.exchange,
      exchangeLabel: exchangeLabel(),
      env: config.env,
      envLabel: envLabel(),
      restBaseUrl: restBaseUrl(),
      keys: keyHint(),
      keysByEnv: keysByEnv(),
      liveTrading: config.liveTrading,
      ai: { configured: aiKeyHint().configured, baseUrl: config.ai.baseUrl, model: config.ai.model, hint: aiKeyHint().hint },
    });
  }));

  /**
   * 切环境。和写密钥分开，因为这是会改变「钱从哪个账户出」的动作。
   * 一律顺手关掉下单开关：切到实盘意味着换成真钱，绝不能把开关一起带过去。
   */
  router.post('/config/env', wrap(async (req, res) => {
    requireLocal(req, '切环境');
    const { env } = bodyOf(req.body);
    if (env !== 'testnet' && env !== 'live') throw new GateError(400, 'BAD_ENV', 'env 只能是 testnet 或 live');
    // 换环境＝换账户。旧令牌是在另一个账户上解锁的，不能跟着过来：
    // 从模拟盘切到实盘时它要是还有效，就等于绕过了一次「用真钱」的确认。
    armTokens.clear();
    /**
     * AI 交易也一起停掉，理由和上面那句一样：换环境就是换账户。
     * 上一轮「在模拟盘上确认过」不该变成实盘上的授权，所以实盘确认也一起清掉。
     */
    stopAiRunner();
    saveStrategy({ ...loadStrategy(), enabled: false, liveConfirmed: false });
    // GATE_ENV 这个名字是历史遗留：模拟盘/实盘这个「环境」对两家交易所都适用，所以没改名
    writeEnv({ GATE_ENV: env, LIVE_TRADING: 'false' });
    res.json({
      ok: true,
      env: config.env,
      envLabel: envLabel(),
      restBaseUrl: restBaseUrl(),
      keys: keyHint(),
      keysByEnv: keysByEnv(),
      liveTrading: config.liveTrading,
    });
  }));

  /**
   * 换交易所。
   *
   * 和切环境一个道理，而且更彻底：合约名、张数口径、持仓、挂单、保护单全都换了账户。
   * 旧账户上的解锁令牌、AI 交易的实盘确认一律作废 —— 在 Gate 上点过的确认
   * 不该变成「在 Bitget 上也能用真钱」的授权。下单开关也一起关掉。
   */
  router.post('/config/exchange', wrap(async (req, res) => {
    requireLocal(req, '切换交易所');
    const { exchange: next } = bodyOf(req.body);
    if (next !== 'gate' && next !== 'bitget') {
      throw new GateError(400, 'BAD_EXCHANGE', 'exchange 只能是 gate 或 bitget');
    }
    if (next !== config.exchange) {
      armTokens.clear();
      stopAiRunner();
      saveStrategy({ ...loadStrategy(), enabled: false, liveConfirmed: false });
      writeEnv({ EXCHANGE: next, LIVE_TRADING: 'false' });
      // 上一家的合约表、乘数缓存不能再拿去算账
      resetExchangeCache();
    }
    res.json({
      ok: true,
      exchange: config.exchange,
      exchangeLabel: exchangeLabel(),
      intervals: exchangeIntervals(),
      env: config.env,
      envLabel: envLabel(),
      restBaseUrl: restBaseUrl(),
      keys: keyHint(),
      keysByEnv: keysByEnv(),
      liveTrading: config.liveTrading,
    });
  }));

  // ---------- 备份 ----------

  /**
   * 导出一份加密备份。
   *
   * 一个文件里同时装服务端和页面的状态：只带一半的话，「换台电脑接着用」就只能接一半。
   * 密码在服务端做 KDF，密文才算出来 —— 手机用局域网 IP 打开页面时不是安全上下文，
   * 浏览器不给 crypto.subtle，加密放在页面里就等于手机上用不了。
   *
   * 文件里有两家的 API 密钥，所以：密码至少 8 位、AES-256-GCM（自带完整性校验，
   * 文件被改过会在解密时直接失败），并且只允许本机导出。
   */
  router.post('/backup/export', wrap(async (req, res) => {
    requireLocal(req, '导出备份');
    const { password, local } = bodyOf(req.body);
    const server = collectBackup();
    const browser = sanitizeLocal(local);
    const envelope = encryptBackup(server, browser, password);
    res.json({
      ok: true,
      envelope,
      counts: {
        // 只报个数，不回显内容 —— 密钥不该在响应里出现
        env: server.env.split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*\s*=/.test(l.trim())).length,
        strategies: (() => {
          try { return (JSON.parse(server.strategies || '{}') as { strategies?: unknown[] }).strategies?.length ?? 0; } catch { return 0; }
        })(),
        aiStrategy: server.aiStrategy ? 1 : 0,
        local: Object.keys(browser).length,
      },
    });
  }));

  /**
   * 恢复一份备份。
   *
   * 这是「把整台机器的配置换掉」的操作，所以本机限定；恢复完主动做三件事：
   * 解锁令牌作废（密钥可能换了另一套，旧的确认不该继续有效）、AI 交易停掉
   * （恢复完不该自己开始下单）、交易所适配器的缓存清空（按键重新读）。
   */
  router.post('/backup/import', wrap(async (req, res) => {
    requireLocal(req, '恢复备份');
    const { password, envelope } = bodyOf(req.body);
    const payload = decryptBackup(envelope, password);
    const { applied } = applyBackupFiles(payload.server);

    armTokens.clear();
    stopAiRunner();
    // ai-strategy.json 可能刚从备份里恢复，这里只把开关关掉，规则内容不动
    saveStrategy({ ...loadStrategy(), enabled: false, liveConfirmed: false });
    resetExchangeCache();

    res.json({
      ok: true,
      applied,
      local: sanitizeLocal(payload.local),
      at: payload.createdAt,
      env: config.env,
      envLabel: envLabel(),
      exchange: config.exchange,
      exchangeLabel: exchangeLabel(),
      keys: keyHint(),
    });
  }));

  // ---------- 反馈 ----------

  /**
   * 最近发信的时刻，按来源地址各记一份。
   *
   * 这张表挡的是误连点（一次点击就是一封真邮件）和顺手压测；
   * 正常用的人一分钟内不会发第二封，撞上这一条也只是等一会儿。
   */
  const feedbackSent = new Map<string, number[]>();
  const FB_GAP_MS = 15_000;
  const FB_HOUR_MAX = 10;

  function checkFeedbackRate(ip: string): void {
    const now = Date.now();
    const list = (feedbackSent.get(ip) ?? []).filter((t) => now - t < 60 * 60_000);
    const last = list[list.length - 1] ?? 0;
    if (now - last < FB_GAP_MS) {
      throw new GateError(429, 'TOO_FAST', '刚发过一封，' + Math.ceil((FB_GAP_MS - (now - last)) / 1000) + ' 秒后再发');
    }
    if (list.length >= FB_HOUR_MAX) {
      throw new GateError(429, 'TOO_MANY', '这一小时已经发了 ' + list.length + ' 封，稍后再试');
    }
    feedbackSent.set(ip, [...list, now]);
    // 表别只涨不消：攒到一定量就把过期的整批清掉
    if (feedbackSent.size > 200) {
      for (const [k, v] of feedbackSent) {
        if (v.every((t) => now - t >= 60 * 60_000)) feedbackSent.delete(k);
      }
    }
  }

  /** 用户反馈：服务端用内嵌的 163 信箱直接寄出去，页面上不出现任何邮箱配置 */
  router.post('/feedback', wrap(async (req, res) => {
    const body = bodyOf(req.body);
    const kind = typeof body.kind === 'string' && ['bug', 'idea', 'other'].includes(body.kind) ? body.kind : 'other';
    const title = String(body.title ?? '').trim();
    const text = String(body.body ?? '').trim();
    const contact = String(body.contact ?? '').trim();
    if (title.length < 2 || title.length > 80) throw new GateError(400, 'BAD_TITLE', '标题写 2 到 80 个字');
    if (text.length < 5 || text.length > 4000) throw new GateError(400, 'BAD_BODY', '内容写 5 到 4000 个字');
    if (contact.length > 120) throw new GateError(400, 'BAD_CONTACT', '联系方式太长了');

    // 只带白名单里的几个字段：整包上报什么都能塞，信就成了一坨没法读的东西
    const extra: Record<string, string> = {};
    const raw = body.extra;
    if (raw && typeof raw === 'object') {
      for (const k of ['合约', '周期', '窗口', '页面', '版本']) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) extra[k] = v.trim().slice(0, 200);
      }
    }

    // 校验放在限流前面：填错的人不该被自己刚才那次错填卡住 15 秒。
    // 校验不过根本不会发信，所以这里攒不出邮件洪水
    checkFeedbackRate(req.socket.remoteAddress ?? '');

    try {
      const out = await sendFeedback({ kind, title, body: text, contact, extra });
      console.log('[feedback] 已发出：' + title.slice(0, 40));
      res.json({ ok: true, to: out.to, at: out.at });
    } catch (e) {
      if (e instanceof FeedbackError) throw new GateError(502, e.label, e.message);
      throw e;
    }
  }));

  /**
   * 拉接口支持的模型列表，省得用户去猜名字。
   * 地址和密钥可以现场传（还没保存也要能拉），不传就用已保存的。
   */
  router.post('/ai/models', wrap(async (req, res) => {
    requireLocal(req, '拉模型列表');
    const body = bodyOf(req.body);
    const override = {
      baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : config.ai.baseUrl,
      apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.ai.apiKey,
      model: config.ai.model,
    };
    const models = await listModels(override);
    res.json({ models, current: config.ai.model, endpoint: aiEndpoint(override.baseUrl) });
  }));

  // ---------- 本机出口 IP ----------

  interface IpInfo {
    ok: boolean;
    ip: string;
    country?: string;
    region?: string;
    city?: string;
    isp?: string;
    /** 是哪个查询接口答的，排查时用 */
    source?: string;
    at: number;
    error?: string;
  }

  /**
   * 本机出网 IP。Gate 的 API 密钥按 IP 白名单时，填的就是这个地址。
   *
   * 由服务端去问，不让浏览器直连：那几个查询接口都不带跨域头。
   * 三家依次兜底，一家挂了换下一家；全挂就如实说，不编一个地址出来。
   */
  const IP_SOURCES: { url: string; host: string; pick: (j: Record<string, unknown>) => Omit<IpInfo, 'ok' | 'at' | 'source'> }[] = [
    {
      url: 'https://ipinfo.io/json',
      host: 'ipinfo.io',
      pick: (j) => ({
        ip: String(j.ip ?? ''),
        country: j.country ? String(j.country) : undefined,
        region: j.region ? String(j.region) : undefined,
        city: j.city ? String(j.city) : undefined,
        isp: j.org ? String(j.org) : undefined,
      }),
    },
    {
      url: 'https://api.ip.sb/geoip',
      host: 'api.ip.sb',
      pick: (j) => ({
        ip: String(j.ip ?? ''),
        country: j.country ? String(j.country) : undefined,
        region: j.region ? String(j.region) : undefined,
        city: j.city ? String(j.city) : undefined,
        isp: j.organization ? String(j.organization) : undefined,
      }),
    },
    {
      url: 'https://api.ipify.org?format=json',
      host: 'ipify.org',
      pick: (j) => ({ ip: String(j.ip ?? '') }),
    },
  ];

  /** IPv4 或 IPv6，够用就行；挡掉接口回一句 HTML 被塞进 ip 字段的情况 */
  const looksLikeIp = (v: string): boolean => /^[0-9a-fA-F:.]{3,45}$/.test(v) && (v.includes('.') || v.includes(':'));

  async function detectIp(direct = false): Promise<IpInfo> {
    for (const src of IP_SOURCES) {
      try {
        const r = await netFetch(
          src.url,
          {
            headers: { accept: 'application/json', 'user-agent': 'xf-rine' },
            signal: AbortSignal.timeout(4000),
          },
          { direct },
        );
        if (!r.ok) continue;
        const got = src.pick(await r.json() as Record<string, unknown>);
        if (looksLikeIp(got.ip)) return { ok: true, ...got, source: src.host, at: Date.now() };
      } catch { /* 这家不通就换下一家 */ }
    }
  return { ok: false, ip: '', at: Date.now(), error: '几个查询接口都没答上来（可能没网，或者被代理拦了）' };
}

/** 同一分钟内重复点就是看同一个结果，别每次都去问三家。只缓存 IP 本身，代理状态一律现取 */
let ipCache: { at: number; info: IpInfo; directIp?: string } | null = null;

router.get('/ip', wrap(async (req, res) => {
  // 出口 IP 是个会变的值，任何一层缓存留着都会让人以为「没重新检测」
  res.set('Cache-Control', 'no-store, max-age=0');
  const fresh = String(req.query.fresh ?? '') === '1';
  // 手动点「重新检测」时连代理状态一起重新确认：用户刚换了代理，这一步要跟上
  if (fresh) await refreshProxy(true);
  if (!fresh && ipCache && Date.now() - ipCache.at < 60_000) {
    res.json({ ...ipCache.info, proxy: proxyState(), ...(ipCache.directIp ? { directIp: ipCache.directIp } : {}) });
    return;
  }

  const info = await detectIp();
  // 代理开着时再问一次直连出口：Gate 的白名单认的是这个地址
  const directInfo = proxyState().on ? await detectIp(true).catch(() => null) : null;
  const directIp = directInfo?.ok ? directInfo.ip : undefined;
  ipCache = { at: Date.now(), info, ...(directIp ? { directIp } : {}) };
  res.json({ ...info, proxy: proxyState(), ...(directIp ? { directIp } : {}) });
}));

router.get('/diag', wrap(async (_req, res) => {
  const out: Record<string, unknown> = {
    exchange: config.exchange,
    exchangeLabel: exchangeLabel(),
    env: config.env,
    envLabel: envLabel(),
    restBaseUrl: restBaseUrl(),
    keys: keyHint(),
    liveTrading: config.liveTrading,
  };
  try {
    exchange().requireKeys();
    const acct = await exchange().account();
    out.privateOk = true;
    out.account = acct;
  } catch (e) {
    out.privateOk = false;
    out.privateError = e instanceof GateError ? `${e.label}: ${e.detail}` : String(e);
  }
  res.json(out);
}));

}