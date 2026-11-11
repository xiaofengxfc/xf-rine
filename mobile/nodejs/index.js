/**
 * 手机上的 Node 入口。
 *
 * 电脑版是把服务端当子进程拉起来，手机上没有「另起一个进程」这回事 ——
 * 这个文件就是那个进程：真 Node 运行时跑在 App 进程里（nodejs-mobile），
 * 外面那层 WebView 只是块屏幕。
 *
 * 所以手机上什么都是本地完成的：K 线、支撑阻力、新闻、AI、下单，全在这台手机上算，
 * 不需要电脑开着，也不需要同一个 Wi-Fi。
 */
const path = require('node:path');
const fs = require('node:fs');
const util = require('node:util');
const net = require('node:net');

/**
 * 启动过程说的每一句话都留一份。
 *
 * 手机上服务端起不来时，页面只看到一句「没开起端口」，而真正的原因（哪一行抛的、
 * 缺什么）原本只进了 logcat —— 小米这类系统不让 adb 读 logcat，等于没有。
 * 所以这里把话同时送到三个地方：页面（立即可见）、日志文件（事后可查）、stdout（照旧）。
 */
const BOOT_LINES = [];
const BOOT_MAX = 160;

let channel = null;
try {
  // 拿到桥就意味着「Node 醒了」也算报到宿主那里，一举两得。
  // 单独用 node 跑这个文件时没有桥，忽略即可。
  channel = require('bridge').channel;
} catch (e) { /* 没有桥：只影响往页面报进度 */ }

const home = process.env.XFRINE_HOME || path.resolve(__dirname, '../../xf-rine');
try {
  fs.mkdirSync(home, { recursive: true });
} catch (e) {
  console.error('[nodejs] 建数据目录失败：' + e.message);
}
process.env.XFRINE_HOME = home;

const LOG_PATH = path.join(home, 'boot.log');
try { fs.writeFileSync(LOG_PATH, '', 'utf8'); } catch (e) { /* 写不了就只走页面 */ }


/**
 * 记一句话。
 *
 * @param {string} stage 阶段：index/home/token/server/listen/error/abort
 * @param {string} text  这一行的内容
 */
function say(stage, text) {
  const line = String(text == null ? '' : text).replace(/\s+$/, '');
  const entry = '[' + stage + '] ' + line;
  BOOT_LINES.push(entry);
  if (BOOT_LINES.length > BOOT_MAX) BOOT_LINES.shift();
  try { fs.appendFileSync(LOG_PATH, entry + '\n', 'utf8'); } catch (e) { /* 忽略 */ }
  try {
    if (channel) channel.send({ kind: 'boot', stage, line });
  } catch (e) { /* 页面已经不在就算了 */ }
}

/**
 * 服务端自己的 console 输出也接过来。
 *
 * 它打印的正是「端口起了没有、密钥配没配、出网走哪条」——
 * 起不来的时候这几行往往就是答案。
 */
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    say('server', util.format(...args));
  };
}

say('index', 'Node ' + process.version + '  ' + process.platform + '/' + process.arch);
say('home', '数据目录 ' + home);

// 只提供接口；页面在 App 的内置资源里，不需要这里再托管一份
process.env.XFRINE_API_ONLY = '1';
// 手机上没有别的程序抢这个端口，固定住即可
process.env.PORT = process.env.PORT || '8787';

/**
 * 起不来的时候怎么办。
 *
 * 这里不能 process.exit —— nodejs-mobile 的运行时就在 App 进程里，
 * 退出这个「进程」等于把 App 一起带走，用户看到的就是启动闪退，
 * 一句提示都没有。留着事件循环空转，页面那边会走到「服务端没起来」，
 * 至少能把话说明白；原因也已经送到页面上了。
 */
function bail(reason) {
  say('abort', reason);
  console.error('[nodejs] ' + reason);
  setInterval(() => {}, 1 << 30);
}

/**
 * 口令。
 *
 * Android 上的 127.0.0.1 是整个设备共用的 —— 同一个手机里别的应用也能连到这个端口，
 * 而后面是下单、平仓、密钥。所以这里要求「连本机也带口令」，
 * 口令由页面那边随机生成、启动时通过环境变量传进来，只有 App 自己的 WebView 知道。
 */
process.env.XFRINE_REQUIRE_TOKEN = '1';
const token = process.env.REMOTE_TOKEN || '';
if (!token) {
  bail('没拿到访问口令，拒绝启动 —— 页面应该通过 env 传进来');
} else {
  say('token', '口令已收到（' + token.length + ' 位）');
  say('server', '开始加载服务端…');

  let loaded = true;
  try {
    require('./server.js');
    say('server', '服务端脚本加载完成，等端口 ' + process.env.PORT);
  } catch (e) {
    loaded = false;
    bail('服务端加载失败：' + (e && e.stack ? e.stack : e));
  }

  /**
   * 端口起没起，自己在进程里量。
   *
   * 页面那边靠 HTTP 探活，按时限探不到也只知道「没开起端口」；
   * 这里每半秒连一次，通了直接报「起来了」，不通就把最近几行连同原因一起报上去，
   * 免得人对着一个转圈的第一屏猜。
   */
  let waited = 0;
  if (loaded) {
    const probe = setInterval(() => {
      waited += 500;
      const sock = net.connect({ host: '127.0.0.1', port: Number(process.env.PORT) }, () => {
        clearInterval(probe);
        sock.destroy();
        say('listen', '端口 ' + process.env.PORT + ' 已就绪，用时 ' + waited + 'ms');
      });
      sock.on('error', () => { sock.destroy(); });
      if (waited >= 30_000) {
        clearInterval(probe);
        say('error', '30 秒内端口没起来，最近的输出：');
        for (const l of BOOT_LINES.slice(-12)) say('error', '  ' + l);
      }
    }, 500);
  }
}
