import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 手机端。
 *
 * 装的是整个程序，不是一块连电脑的屏幕：Node 运行时（nodejs-mobile）跑在 App 进程里，
 * 服务端就在手机上算，行情、支撑阻力、新闻、AI、下单全都在本地完成。
 * 页面这一层仍然只有 web/dist 一份，和桌面端、浏览器里看到的一样。
 */
const config: CapacitorConfig = {
  appId: 'com.xfrine.terminal',
  appName: '巡风',
  webDir: '../web/dist',
  plugins: {
    Nodejs: {
      // 服务端打好的产物放在 web/dist/nodejs/，见 tools/bundle-server.mjs
      nodeDir: 'nodejs',
      // 手动启动：BootGate 要先定好数据目录再起引擎
      startMode: 'manual',
    },
  },
  server: {
    /**
     * 页面自己的源用 http。
     *
     * 内置服务端是 http://127.0.0.1:8787，没有证书；页面要是从 https://localhost 出来，
     * 浏览器会按混合内容把请求全掐掉，表现是「服务端明明起着，页面一片空白」。
     */
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0c0e12',
  },
};

export default config;
