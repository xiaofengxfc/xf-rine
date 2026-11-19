package com.xfrine.terminal;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 壳。
 *
 * 两件事原来都没做，手机上看就是「上面一条黑边、内容被顶下去」：
 *
 *   1. **没开 edge-to-edge**。窗口还是「给系统栏让位」的模式，WebView 从状态栏下面才开始，
 *      所以页面画到不了屏幕最上面。targetSdk 已经是 36，Android 15 起本来就该是铺满的，
 *      但窗口层的 decorFitsSystemWindows 仍然是 true，得自己关掉。
 *
 *   2. **系统栏尺寸没传给页面**。配置里写了 SystemBars 插件，可那个包根本没装，
 *      window.Capacitor.Plugins.SystemBars 是 undefined，CSS 里的 --safe-area-inset-*
 *      一直是 0。这里自己算好，直接塞进 CSS 变量 —— 页面那套 --inset-* 已经优先读它。
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

        // 先铺满，再由页面用 CSS 变量让位
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        super.onCreate(savedInstanceState);
        // Keep the native toolbar disabled on Android versions that ignore postSplashScreenTheme.
        if (getSupportActionBar() != null) getSupportActionBar().hide();

        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (getBridge() != null && getBridge().getWebView() != null) {
            // WebView 自己也要透明，否则手势条那一条会是 WebView 的默认底色
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        }
        watchInsets();
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

    /**
     * 状态栏图标的深浅。
     *
     * 页面那边（web/src/lib/theme.ts）一直按 cap.Plugins.SystemBars 去找这个插件，
     * 但工程里从来没装过 @capacitor/system-bars —— 于是「深色页面配浅色图标」这条一直没生效。
     * 这里补一个同名的原生插件，页面代码一个字都不用改。
     */
    @CapacitorPlugin(name = "SystemBars")
    public static class SystemBarsPlugin extends Plugin {
        /**
         * 系统栏尺寸（CSS 像素）。
         *
         * 页面启动时主动来问一次 —— 光靠壳那边往页面里 push 不行：
         * 页面加载、刷新都会清掉写在 <html> 上的内联变量，而 push 可能早就跑完了。
         * 由页面来取，什么时候加载都能拿到当下的真值。
         */
        @PluginMethod
        public void getInsets(PluginCall call) {
            View decor = getActivity().getWindow().getDecorView();
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            float density = getActivity().getResources().getDisplayMetrics().density;
            if (density <= 0) density = 1f;
            JSObject out = new JSObject();
            if (insets == null) {
                out.put("top", 0); out.put("right", 0); out.put("bottom", 0); out.put("left", 0);
            } else {
                Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                Insets gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures());
                out.put("top", bars.top / density);
                out.put("right", bars.right / density);
                out.put("bottom", Math.max(bars.bottom, gestures.bottom) / density);
                out.put("left", bars.left / density);
            }
            call.resolve(out);
        }

        @PluginMethod
        public void setStyle(PluginCall call) {
            String style = call.getString("style", "DARK");
            // LIGHT = 浅色底 → 用深色图标
            final boolean light = "LIGHT".equalsIgnoreCase(style);
            /**
             * 插件方法是跑在 Capacitor 的插件线程上的，不是 UI 线程。
             * 直接改系统栏外观会抛 CalledFromWrongThreadException，整个进程崩掉 ——
             * 这个坑第一次打包装上去就踩到了（页面一启动切主题就闪退）。
             * 必须切回 UI 线程再动 View。
             */
            getActivity().runOnUiThread(() -> {
                Window window = getActivity().getWindow();
                WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(window, window.getDecorView());
                ctl.setAppearanceLightStatusBars(light);
                ctl.setAppearanceLightNavigationBars(light);
            });
            call.resolve();
        }
    }
}
