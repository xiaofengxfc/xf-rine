import { allowedOrigin, isLoopbackAddress } from '../src/httpSecurity.js';

const checks: [string, boolean][] = [
  ['reject DNS origins even when their host matches the request',
    allowedOrigin('http://evil.example:8787', 'evil.example:8787') === ''],
  ['allow matching IPv4 LAN origins',
    allowedOrigin('http://192.168.1.7:8787', '192.168.1.7:8787') === 'http://192.168.1.7:8787'],
  ['allow matching IPv6 LAN origins',
    allowedOrigin('http://[fd00::7]:8787', '[fd00::7]:8787') === 'http://[fd00::7]:8787'],
  ['allow loopback browser origins',
    allowedOrigin('http://localhost:5173', '127.0.0.1:8787') === 'http://localhost:5173'],
  ['recognize IPv4 loopback', isLoopbackAddress('127.0.0.1')],
  ['recognize IPv4-mapped loopback', isLoopbackAddress('::ffff:127.0.0.1')],
  ['recognize IPv6 loopback', isLoopbackAddress('::1')],
  ['reject non-loopback IPv6 ending in ::1', !isLoopbackAddress('2001:db8::1')],
];

let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

if (failures) process.exit(1);
console.log('✓ HTTP origin and local-address checks passed');
