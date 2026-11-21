'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { envHas, readEnvNumber, readEnvString, setEnvLine, withNetworkDefaults } = require('../electron/environment.cjs');

test('reads configured values without changing the saved text', () => {
  const text = 'PORT=8790\nHOST=127.0.0.1\n';

  assert.equal(envHas(text, 'PORT'), true);
  assert.equal(readEnvNumber(text, 'PORT'), 8790);
  assert.equal(readEnvString(text, 'HOST'), '127.0.0.1');
});

test('writes one setting while preserving unrelated values', () => {
  const text = setEnvLine('PORT=8787\nREMOTE_TOKEN=keep-me\n', 'PORT', '8788');
  const appended = setEnvLine('REMOTE_TOKEN=keep-me\n', 'PORT', '8788');

  assert.equal(text, 'PORT=8788\nREMOTE_TOKEN=keep-me\n');
  assert.equal(appended, 'REMOTE_TOKEN=keep-me\nPORT=8788\n');
});

test('adds missing network settings and retains explicit settings', () => {
  const configured = withNetworkDefaults('EXCHANGE=bitget\n', 'generated-token');
  const existing = withNetworkDefaults('HOST=127.0.0.1\nREMOTE_TOKEN=existing\n', 'unused-token');

  assert.equal(configured.text, 'EXCHANGE=bitget\nHOST=0.0.0.0\nREMOTE_TOKEN=generated-token\n');
  assert.equal(configured.host, '0.0.0.0');
  assert.equal(existing.text, 'HOST=127.0.0.1\nREMOTE_TOKEN=existing\n');
  assert.equal(existing.host, '127.0.0.1');
});

test('an empty host setting keeps the loopback-access default', () => {
  const result = withNetworkDefaults('HOST=\nREMOTE_TOKEN=existing\n', 'unused-token');

  assert.equal(result.text, 'HOST=\nREMOTE_TOKEN=existing\n');
  assert.equal(result.host, '0.0.0.0');
});
