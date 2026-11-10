import type { IpInfo } from './api.ts';

type Picked = Omit<IpInfo, 'ok' | 'at' | 'source'>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * 支持跨域的查询接口，浏览器能直接问。
 * 依次兜底，一家被代理或扩展拦了就换下一家。
 */
const SOURCES: { url: string; host: string; pick: (j: Record<string, any>) => Picked }[] = [
  {
    url: 'https://ipinfo.io/json',
    host: 'ipinfo.io',
    pick: (j) => ({
      ip: String(j.ip ?? ''),
      country: str(j.country),
      region: str(j.region),
      city: str(j.city),
      isp: str(j.org),
    }),
  },
  {
    url: 'https://ipwho.is/',
    host: 'ipwho.is',
    pick: (j) => ({
      ip: String(j.ip ?? ''),
      country: str(j.country_code),
      region: str(j.region),
      city: str(j.city),
      isp: str(j.connection?.organization),
    }),
  },
  {
    url: 'https://api.ip.sb/geoip',
    host: 'api.ip.sb',
    pick: (j) => ({
      ip: String(j.ip ?? ''),
      country: str(j.country_code) ?? str(j.country),
      region: str(j.region),
      city: str(j.city),
      isp: str(j.organization),
    }),
  },
  {
    url: 'https://api64.ipify.org?format=json',
    host: 'ipify.org',
    pick: (j) => ({ ip: String(j.ip ?? '') }),
  },
];

const looksLikeIp = (v: string): boolean => /^[0-9a-fA-F:.]{3,45}$/.test(v) && (v.includes('.') || v.includes(':'));

/**
 * 当前 IP：由浏览器自己问。
 *
 * 请求走的是浏览器当下的网络，系统代理和 VPN 都算在内 —— 问到的就是这台机器现在对外是谁。
 * 服务端的 /api/ip 是 Node 直连出去的：Node 不读系统代理，两者经常不是一个地址。
 */
export async function detectBrowserIp(): Promise<IpInfo> {
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const got = src.pick(await res.json() as Record<string, any>);
      if (looksLikeIp(got.ip)) return { ok: true, ...got, source: src.host, at: Date.now() };
    } catch { /* 这家不通就换下一家 */ }
  }
  return { ok: false, ip: '', at: Date.now(), error: '浏览器问不到（被代理、VPN 或扩展拦了）' };
}
