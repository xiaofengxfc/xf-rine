package com.xfrine.terminal;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "PythonEngine")
public class PythonEnginePlugin extends Plugin {
    private static final ExecutorService STARTER = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token", "").trim();
        if (token.length() < 16) {
            call.reject("Python 引擎访问口令长度不足");
            return;
        }

        STARTER.execute(() -> {
            try {
                if (!Python.isStarted()) {
                    Python.start(new AndroidPlatform(getContext()));
                }
                PyObject service = Python.getInstance().getModule("service");
                int port = service.callAttr("start_embedded", token).toInt();
                if (port <= 0) {
                    call.reject("Python 引擎没有返回有效端口");
                    return;
                }

                JSObject result = new JSObject();
                result.put("port", port);
                call.resolve(result);
            } catch (Exception error) {
                String detail = error.getMessage();
                call.reject("启动内嵌 Python 引擎失败" + (detail == null ? "" : "：" + detail), error);
            }
        });
    }
}
