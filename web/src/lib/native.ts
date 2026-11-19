import { isNative } from './endpoint.ts';
import { syncSystemBars } from './theme.ts';

/**
 * 安卓的返回键。
 *
 * 默认行为是直接退出程序。设置页开着、左栏抽屉开着的时候按返回，
 * 人想的是「关掉这一层」，不是「退出」—— 一按就退出，下次进来还得重新找合约。
 *
 * 所以先问上层要不要收：页面里监听 xf-back，收掉了就 preventDefault。
 * 没人接手才退出。
 */
/**
 * 系统栏尺寸。
 *
 * Android WebView 不认识屏幕挖孔和手势条，`env(safe-area-inset-*)` 全是 0 ——
 * 于是顶栏贴着状态栏画，第一行按钮被时间、电量挡掉一半。
 *
 * 壳那边（mobile/android/.../MainActivity.java）开了 edge-to-edge，也注册了一个
 * 同名的 SystemBars 插件，能报出真实的 inset。这里主动去问，拿到就写成 CSS 变量：
 * 页面里那套 --inset-* 已经优先读它（见 styles.css）。
 *
 * 为什么是「页面来问」而不是「壳往里推」：页面加载和刷新都会清掉写在 <html> 上的
 * 内联变量，而壳那次推送可能早就跑完了 —— 刷新一次就退回 0。
 */
export async function applySafeInsets(): Promise<void> {
  if (!isNative()) return;
  const cap = (globalThis as {
    Capacitor?: { Plugins?: Record<string, unknown>; registerPlugin?: (name: string) => unknown };
  }).Capacitor;
  if (!cap) return;
  const plugin = (cap.Plugins?.SystemBars ?? cap.registerPlugin?.('SystemBars')) as
    | { getInsets?: () => Promise<{ top: number; right: number; bottom: number; left: number }> }
    | undefined;
  if (!plugin?.getInsets) return;
  try {
    const i = await plugin.getInsets();
    const root = document.documentElement;
    // 单位已经是 CSS 像素，别再乘 dpr；负数（个别机型会给）当 0
    root.style.setProperty('--safe-area-inset-top', Math.max(0, Number(i.top) || 0) + 'px');
    root.style.setProperty('--safe-area-inset-right', Math.max(0, Number(i.right) || 0) + 'px');
    root.style.setProperty('--safe-area-inset-bottom', Math.max(0, Number(i.bottom) || 0) + 'px');
    root.style.setProperty('--safe-area-inset-left', Math.max(0, Number(i.left) || 0) + 'px');
  } catch {
    /* 插件没装进来就算了，退回 env() 的 0 —— 至少页面能用 */
  }
}

export async function installBackHandler(): Promise<void> {
  if (!isNative()) return;
  try {
    // 只在 App 里需要：浏览器和桌面端没有硬件返回键，别把这段塞进 PC 的包里
    const { App } = await import('@capacitor/app');
    // 上面这一句 import 之后壳的插件表才齐，状态栏图标颜色和系统栏尺寸这时再对一遍
    syncSystemBars();
    await applySafeInsets();
    // 转屏 / 分屏之后 inset 会变，再问一次
    window.addEventListener('resize', () => { void applySafeInsets(); });
    window.addEventListener('orientationchange', () => { void applySafeInsets(); });
    await App.addListener('backButton', () => {
      const ev = new CustomEvent('xf-back', { cancelable: true });
      const handled = !window.dispatchEvent(ev);
      if (!handled) void App.exitApp();
    });
  } catch {
    // 插件没装进来就退回默认行为，别把整个页面弄崩
  }
}
