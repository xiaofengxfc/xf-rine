package com.xfrine.terminal;

import android.view.View;
import android.view.Window;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Provides the CSS-pixel inset values and theme controls used by the web app. */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {
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
        final boolean light = "LIGHT".equalsIgnoreCase(style);
        // Capacitor invokes plugin methods off the Android UI thread.
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(light);
            controller.setAppearanceLightNavigationBars(light);
        });
        call.resolve();
    }
}
