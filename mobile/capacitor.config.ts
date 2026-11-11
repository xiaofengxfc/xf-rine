import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 手机端。
 *
 * 手机只是一块屏幕：所有计算在电脑上做（行情、支撑阻力、下单），
 * 手机负责显示和下单，通过局域网连电脑上跑的同一个服务端。
 *
 * 这里不再挂 Node 运行时插件：把整个后端塞进 APK 的那套已经去掉了，
 * 代价是多几十兆原生库、每个算法改动都要重打包、换机换系统一堆加载失败的兼容问题 ——
 * 而手机本来也用不上「读本地数据目录」和「连交易所代理」这些只有电脑才有的东西。
 *
 * 页面这一层仍然只有 web/dist 一份，和桌面端、浏览器里看到的一样。
 */
const config: CapacitorConfig = {
  appId: 'com.xfrine.terminal',
  appName: '巡风',
  webDir: '../web/dist',
  plugins: {
    /**
     * 系统栏（状态栏、手势条）。
     *
     * 页面写了 viewport-fit=cover，意思是「我要画到系统栏底下，让位自己来」。
     * 这里提前把这件事告诉壳：不然首帧会先按「缩进去」排一遍，再跳成整屏。
     * 让位尺寸由壳注入成 --safe-area-inset-*（见 web/src/styles.css 的 --inset-*）。
     *
     * style 只是首帧用的：页面起来之后会按自己的主题改过来，
     * 见 web/src/lib/theme.ts 的 syncSystemBars —— 系统和页面的深浅色不一定一致。
     */
    SystemBars: {
      initialViewportFitValueHint: 'cover',
      style: 'DARK',
    },
  },
  server: {
    /**
     * 页面自己的源用 http。
     *
     * WebView 从 http://localhost 加载页面，而电脑上的服务端也是 http ——
     * 页面要是从 https://localhost 出来，浏览器会按混合内容把请求全掐掉，
     * 表现是「地址填对了、服务端明明起着，页面一片空白」。
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
