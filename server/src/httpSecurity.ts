import { isIP } from 'node:net';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Treat only parsed loopback addresses as local, including IPv4-mapped socket addresses. */
export function isLoopbackAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === '::1') return true;
  const ipv4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

/** Reflect trusted loopback origins and same-host IP literals used for direct LAN access. */
export function allowedOrigin(origin: string, requestHost: string): string {
  if (!origin || origin === 'null') return '';
  let url: URL;
  try { url = new URL(origin); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  const hostname = url.hostname.toLowerCase();
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(normalizedHost)) return origin;

  const sameHost = url.host.toLowerCase() === requestHost.toLowerCase();
  return sameHost && isIP(normalizedHost) !== 0 ? origin : '';
}
