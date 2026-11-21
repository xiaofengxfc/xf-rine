import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 手机端。
 *
 * APK 内运行 Node 后端和 Python 支撑阻力引擎，手机可以独立看盘、测试和交易。
 *
 * 页面这一层仍然只有 web/dist 一份，和桌面端、浏览器里看到的一样。
 */
const config: CapacitorConfig = {
  appId: 'com.xfrine.terminal',
  appName: '巡风',
  webDir: '../web/dist',
  plugins: {
    Nodejs: {
      nodeDir: 'nodejs',
      startMode: 'manual',
    },
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
