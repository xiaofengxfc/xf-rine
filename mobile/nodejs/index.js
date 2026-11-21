const path = require('node:path');
const fs = require('node:fs');

const home = process.env.XFRINE_HOME || path.resolve(__dirname, '../../xf-rine');
fs.mkdirSync(home, { recursive: true });
process.env.XFRINE_HOME = home;
process.env.XFRINE_API_ONLY = '1';
process.env.PORT = process.env.PORT || '8787';
process.env.XFRINE_REQUIRE_TOKEN = '1';

if (!process.env.REMOTE_TOKEN) {
  console.error('[mobile] 缺少本机访问口令，拒绝启动');
  process.exit(1);
}

try { require('bridge'); } catch { /* 单独运行时没有原生桥 */ }
require('./server.js');
