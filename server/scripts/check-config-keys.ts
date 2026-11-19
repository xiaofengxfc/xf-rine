/** Offline checks for complete credentials and live/testnet isolation. */
export {};

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point dotenv at an empty temporary home so a developer's real .env cannot affect this test.
const isolatedHome = mkdtempSync(join(tmpdir(), 'xfrine-config-check-'));
process.env.XFRINE_HOME = isolatedHome;
process.env.EXCHANGE = 'gate';
process.env.GATE_ENV = 'live';
process.env.GATE_KEY = 'legacy-key-for-test';
process.env.GATE_SECRET = 'legacy-secret-for-test';
for (const name of [
  'GATE_LIVE_KEY', 'GATE_LIVE_SECRET', 'GATE_TESTNET_KEY', 'GATE_TESTNET_SECRET',
  'BITGET_LIVE_KEY', 'BITGET_LIVE_SECRET', 'BITGET_LIVE_PASSPHRASE',
  'BITGET_TESTNET_KEY', 'BITGET_TESTNET_SECRET', 'BITGET_TESTNET_PASSPHRASE',
]) delete process.env[name];

const { keyHint, keyHintFor, reloadConfig } = await import('../src/config.js');
let failures = 0;
function check(name: string, passed: boolean): void {
  if (passed) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

reloadConfig();
check('Gate legacy credentials configure only the active environment',
  keyHint().configured && keyHintFor('live', 'gate').configured && !keyHintFor('testnet', 'gate').configured);
check('Gate hint remains masked', keyHint().hint.includes('••••') && !keyHint().hint.includes('legacy'));

process.env.GATE_ENV = 'testnet';
reloadConfig();
check('Legacy Gate credentials follow the selected environment',
  keyHint().configured && keyHintFor('testnet', 'gate').configured && !keyHintFor('live', 'gate').configured);

process.env.EXCHANGE = 'gate';
process.env.GATE_ENV = 'live';
process.env.GATE_LIVE_KEY = 'named-gate-key';
delete process.env.GATE_SECRET;
delete process.env.GATE_LIVE_SECRET;
reloadConfig();
check('Gate key without secret is not reported configured', !keyHint().configured && Boolean(keyHint().hint));

process.env.EXCHANGE = 'bitget';
process.env.BITGET_LIVE_KEY = 'named-bitget-key';
process.env.BITGET_LIVE_SECRET = 'named-bitget-secret';
delete process.env.BITGET_LIVE_PASSPHRASE;
reloadConfig();
check('Bitget requires key, secret and passphrase', !keyHint().configured);
process.env.BITGET_LIVE_PASSPHRASE = 'named-bitget-passphrase';
reloadConfig();
check('Bitget reports configured when all credentials are present', keyHint().configured);

rmSync(isolatedHome, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('✓ credential status checks passed');
