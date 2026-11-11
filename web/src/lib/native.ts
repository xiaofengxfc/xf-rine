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
export async function installBackHandler(): Promise<void> {
  if (!isNative()) return;
  try {
    // 只在 App 里需要：浏览器和桌面端没有硬件返回键，别把这段塞进 PC 的包里
    const { App } = await import('@capacitor/app');
    // 上面这一句 import 之后壳的插件表才齐，状态栏图标颜色这时再对一遍
    syncSystemBars();
    await App.addListener('backButton', () => {
      const ev = new CustomEvent('xf-back', { cancelable: true });
      const handled = !window.dispatchEvent(ev);
      if (!handled) void App.exitApp();
    });
  } catch {
    // 插件没装进来就退回默认行为，别把整个页面弄崩
  }
}
