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

/**
 * 数据目录。
 *
 * App 私有空间里的 xf-rine/ 一份，和电脑上的 %APPDATA%\\巡风、仓库里的 server/.env
 * 各存各的 —— 密钥、设置、缓存都不会串。
 * （Android 本身就把每个 App 关在自己的沙盒里，这里再单独开一层，
 *   是为了不跟 Node 运行时的临时文件、缓存目录混在一起。）
 */
const home = process.env.XFRINE_HOME || path.resolve(__dirname, '../../xf-rine');
try {
  fs.mkdirSync(home, { recursive: true });
} catch (e) {
  console.error('[nodejs] 建数据目录失败：' + e.message);
}
process.env.XFRINE_HOME = home;

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
 * 至少能把话说明白；原因也会进 logcat。
 */
function bail(reason) {
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
if (!process.env.REMOTE_TOKEN) {
  bail('没拿到访问口令，拒绝启动 —— 页面应该通过 env 传进来');
} else {
  // 宿主用这个模块判断「Node 已经起来了」，没接上也不影响服务端本身
  try {
    require('bridge');
  } catch { /* 单独跑这个文件时没有桥 */ }

  try {
    require('./server.js');
  } catch (e) {
    bail('服务端加载失败：' + (e && e.stack ? e.stack : e));
  }
}
