'use strict';

const net = require('node:net');

const COMMON_PORTS = [8787, 8788, 8789, 8790, 8791, 8792];

function portTaken(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(900);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Check the loopback listener before binding the configured host. On Windows a
 * specific 127.0.0.1 listener can coexist with a wildcard listener and receive
 * the desktop app's requests first.
 */
async function portFree(port, host) {
  if (await portTaken(port)) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** Reuse the saved port when possible, then a familiar port, then an OS port. */
async function pickPort(preferred, skip, host) {
  if (preferred && !skip.has(preferred) && await portFree(preferred, host)) return preferred;

  for (const port of COMMON_PORTS) {
    if (!skip.has(port) && await portFree(port, host)) return port;
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

module.exports = { pickPort, portFree, portTaken };
