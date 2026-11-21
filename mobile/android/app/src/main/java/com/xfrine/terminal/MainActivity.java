package com.xfrine.terminal;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.hardware.display.DisplayManager;
import android.view.Display;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 壳。
 *
 * 两件事原来都没做，手机上看就是「上面一条黑边、内容被顶下去」：
 *
 *   1. **没开 edge-to-edge**。窗口还是「给系统栏让位」的模式，WebView 从状态栏下面才开始，
 *      所以页面画到不了屏幕最上面。窗口层的 decorFitsSystemWindows 仍然是 true，得自己关掉。
 *
 *   2. **系统栏尺寸要传给页面**。本地 SystemBars 插件负责主题图标，窗口内边距由这里计算后
 *      写入 CSS 变量 —— 页面那套 --inset-* 已经优先读它。
 *
 * 铺满 + 让位这两步必须成对出现：只铺满不让位，顶部工具栏会钻到状态栏底下；
 * 只让位不铺满，就是现在这样一条黑边。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The launcher uses a splash theme. Switch to the actual shell theme before the WebView
        // is created so a native ActionBar cannot cover the mobile page header.
        setTheme(R.style.AppTheme_NoActionBar);

        // 在 super 之前注册：Capacitor 在 onCreate 里建桥，晚一步就找不到了
        registerPlugin(SystemBarsPlugin.class);
        registerPlugin(PythonEnginePlugin.class);

        // 先铺满，再由页面用 CSS 变量让位
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        super.onCreate(savedInstanceState);
        // Keep the native toolbar disabled on Android versions that ignore postSplashScreenTheme.
        if (getSupportActionBar() != null) getSupportActionBar().hide();

        preferHighRefreshRate();
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (getBridge() != null && getBridge().getWebView() != null) {
            // WebView 自己也要透明，否则手势条那一条会是 WebView 的默认底色
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        }
        watchInsets();
    }

    /**
     * 请求前台窗口优先使用 120Hz，让 WebView 动画和图表手势跟随高刷屏刷新。
     * 只有 60Hz 的设备会使用系统可用的刷新率，不影响行情数据更新频率。
     */
    private void preferHighRefreshRate() {
        Window window = getWindow();
        // 选择最接近 120Hz 的可用档位；60Hz 设备自然回退到 60Hz。
        DisplayManager displayManager = getSystemService(DisplayManager.class);
        Display display = displayManager == null ? null : displayManager.getDisplay(Display.DEFAULT_DISPLAY);
        Display.Mode closest = null;
        if (display != null) {
            for (Display.Mode mode : display.getSupportedModes()) {
                if (closest == null
                    || Math.abs(mode.getRefreshRate() - 120f) < Math.abs(closest.getRefreshRate() - 120f)
                    || (Math.abs(mode.getRefreshRate() - 120f) == Math.abs(closest.getRefreshRate() - 120f)
                        && mode.getRefreshRate() > closest.getRefreshRate())) {
                    closest = mode;
                }
            }
        }
        float preferredRate = closest == null ? 120f : closest.getRefreshRate();
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.preferredRefreshRate = preferredRate;
        window.setAttributes(attributes);
    }

    /**
     * 页面加载是异步的：窗口 inset 往往在 WebView 还没加载出页面时就到了，
     * 那时候 evaluateJavascript 是打到一个空文档上的，写完就丢。
     * 所以每次回到前台连推 8 秒（每 400ms 一次），等页面真正跑起来之后再补上。
     * 重复写同一个值没有副作用，布局也不会动。
     */
    private final Handler pusher = new Handler(Looper.getMainLooper());
    private int pushes = 0;
    private final Runnable pushTask = new Runnable() {
        @Override
        public void run() {
            pushInsets();
            pushes += 1;
            if (pushes < 20) pusher.postDelayed(this, 400);
        }
    };

    @Override
    public void onResume() {
        super.onResume();
        preferHighRefreshRate();
        pushes = 0;
        pusher.removeCallbacks(pushTask);
        pusher.post(pushTask);
    }

    @Override
    public void onPause() {
        pusher.removeCallbacks(pushTask);
        super.onPause();
    }

    /**
     * 盯着系统栏尺寸，一变就写进 CSS 变量。
     *
     * 单位用 dp 折成 px 再除以 density，直接给 px 在某些机型上会多出一倍 ——
     * 页面那边按 CSS 像素算，给错就是顶栏凭空高了一截。
     */
    private void watchInsets() {
        final View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            applyInsets(insets);
            // 不吞掉：吞了 WebView 可能在下一帧又拿不到输入法的 inset
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);
    }

    private void applyInsets(WindowInsetsCompat insets) {
        Insets bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
        );
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) density = 1f;
        Insets gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures());
        float safeBottom = Math.max(bars.bottom, gestures.bottom) / density;
        String js = "document.documentElement.style.setProperty('--safe-area-inset-top','" + (bars.top / density) + "px');"
            + "document.documentElement.style.setProperty('--safe-area-inset-right','" + (bars.right / density) + "px');"
            + "document.documentElement.style.setProperty('--safe-area-inset-bottom','" + safeBottom + "px');"
            + "document.documentElement.style.setProperty('--safe-area-inset-left','" + (bars.left / density) + "px');";
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().post(() -> {
            if (getBridge() == null || getBridge().getWebView() == null) return;
            getBridge().getWebView().evaluateJavascript(js, null);
        });
    }

    private void pushInsets() {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
        if (insets != null) applyInsets(insets);
    }

}
