'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { pickPort, portFree, portTaken } = require('../electron/port-selection.cjs');

async function listen(server, host, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server.address().port;
}

test('detects an occupied listener before offering its port', async () => {
  const server = net.createServer();
  const port = await listen(server, '127.0.0.1');

  try {
    assert.equal(await portTaken(port), true);
    assert.equal(await portFree(port, '127.0.0.1'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('skips remembered ports when selecting a fallback', async () => {
  const skip = new Set([8787, 8788, 8789, 8790, 8791, 8792]);
  const port = await pickPort(0, skip, '127.0.0.1');

  assert.ok(port > 0);
  assert.equal(skip.has(port), false);
  assert.equal(await portFree(port, '127.0.0.1'), true);
});

test('reuses an available saved port', async () => {
  const reservation = net.createServer();
  const preferred = await listen(reservation, '127.0.0.1');
  await new Promise((resolve) => reservation.close(resolve));

  const port = await pickPort(preferred, new Set(), '127.0.0.1');

  assert.equal(port, preferred);
});
