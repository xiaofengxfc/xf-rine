import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, keyHint, restBaseUrl, envLabel } from './config.js';
import { router } from './routes.js';
import { MarketHub } from './gate/market.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));

app.use('/api', router);
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// 生产模式：直接托管已打包的前端
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(resolve(webDist, 'index.html'));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const hub = new MarketHub(wss);
hub.connect();

setInterval(() => {
  const s = hub.status();
  if (!s.alive) console.warn('[ws] gate 掉线，正在重连…');
}, 30_000).unref();

server.listen(config.port, '127.0.0.1', () => {
  const k = keyHint();
  console.log('');
  console.log('  巡风日内台  http://127.0.0.1:' + config.port);
  console.log('  环境      ' + envLabel() + '  ' + restBaseUrl());
  console.log('  密钥      ' + (k.configured ? '已配置 ' + k.hint : '未配置（只能看盘，不能下单）'));
  console.log('  下单      ' + (config.liveTrading ? '已开启' + (config.env === 'live' ? ' —— 用的是真钱，谨慎' : '（模拟盘假钱）') : '关闭（只读）'));
  console.log('  风控上限  杠杆 ' + config.maxLeverage + 'x');
  console.log('');
});

const bye = () => { hub.close(); server.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
