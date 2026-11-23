package com.xfrine.terminal;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 手机上装更新。
 *
 * 电脑端这件事是 Electron 主进程干的：下载、校验、起安装器。安卓上没有主进程那层，
 * 但本地跑着同一个 Node 服务端（127.0.0.1:8787），所以这条路径和电脑端是同一条：
 * /api/update/download?platform=android&version=X，服务端去 GitHub 挑那份 APK 再转发过来。
 *
 * 它做四件页面做不到的事：
 *
 *   1. **落盘和校验**。FileProvider 只能分享 App 自己目录里的文件，所以包下在
 *      files/update/ 下。一边写一边算 sha256，对不上就把半截文件删掉 ——
 *      装一个下一半的包，用户看到的是「应用未安装」，比「下载失败」难懂得多。
 *
 *   2. **记住「下了没装」**。安装器弹出来之后用户按返回、或者压根没授权，包还躺在那里。
 *      元数据写在同一个目录，下次启动页面问 pending() 就能把按钮换成「立即安装」，
 *      而不是让他再下一次一百多兆。
 *
 *   3. **查「安装未知应用」**。API 26 起这个开关按 App 记，没开就调不起安装器。
 *      这里只报状态和负责跳过去，不替用户点开。
 *
 *   4. **把包装给系统安装器**。ACTION_VIEW + FileProvider URI，
 *      装不装、覆盖还是重装由系统自己决定；打开之前先核一遍权限、包名、版本和签名。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** 只留一个下载任务：同时下两个会互相覆盖同一份文件 */
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    /**
     * 第几轮下载。
     *
     * 用计数器而不是一个 boolean：取消发生在下载线程的读循环里，
     * 而下一轮下载会立刻开始 —— 布尔量会被下一个任务顺手改回去，
     * 旧任务于是接着往同一个 .part 里写。
     */
    private final AtomicLong generation = new AtomicLong(0);

    /** App 私有目录，不需要存储权限，也不会被清理程序扫走 */
    private File updateDir() {
        File dir = new File(getContext().getFilesDir(), "update");
        if (!dir.exists() && !dir.mkdirs()) return dir;
        return dir;
    }

    private File metaFile() {
        return new File(updateDir(), "pending.json");
    }

    // ---------- 版本 ----------

    /** 装着的这一份的 versionName。页面用它判断「服务端说的新版是不是真新」 */
    @PluginMethod
    public void version(PluginCall call) {
        JSObject out = new JSObject();
        out.put("version", installedVersionName());
        call.resolve(out);
    }

    private String installedVersionName() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception error) {
            return "";
        }
    }

    private int installedVersionCode() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return versionCodeOf(info);
        } catch (Exception error) {
            return 0;
        }
    }

    private int versionCodeOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return (int) info.getLongVersionCode();
        //noinspection deprecation
        return info.versionCode;
    }

    // ---------- 已经下好的包 ----------

    /**
     * 下好还没装的那一份，没有就不给这个键。
     *
     * 三样都得对得上才算数：元数据在、文件在、大小和记下来的一致。
     * 最后一条挡的是「下到一半被系统清掉」那类残留 —— 让它出现在「立即安装」里，
     * 用户点一下只会拿到系统安装器的「解析包错误」。
     */
    @PluginMethod
    public void pending(PluginCall call) {
        JSObject out = new JSObject();
        JSObject pkg = readPending(readPendingMeta());
        if (pkg != null) out.put("pending", pkg);
        call.resolve(out);
    }

    private JSONObject readPendingMeta() {
        File meta = metaFile();
        if (!meta.exists()) return null;
        try (FileInputStream in = new FileInputStream(meta)) {
            byte[] buffer = new byte[(int) Math.min(meta.length(), 8192)];
            int got = in.read(buffer);
            if (got <= 0) return null;
            return new JSONObject(new String(buffer, 0, got, "UTF-8"));
        } catch (Exception error) {
            return null;
        }
    }

    /** 元数据 + 磁盘上那个文件都核对过，才拼成页面要的形状 */
    private JSObject readPending(JSONObject meta) {
        if (meta == null) return null;
        String name = safeName(meta.optString("name", ""));
        if (name.isEmpty()) return null;
        File file = new File(updateDir(), name);
        if (!file.exists() || !file.isFile()) return null;
        long size = meta.optLong("size", 0);
        if (size > 0 && file.length() != size) return null;
        JSObject out = new JSObject();
        out.put("version", meta.optString("version", ""));
        out.put("name", name);
        out.put("size", file.length());
        out.put("digest", meta.optString("digest", ""));
        out.put("path", file.getAbsolutePath());
        out.put("notes", meta.optString("notes", ""));
        out.put("at", meta.optLong("at", 0));
        return out;
    }

    // ---------- 下载 ----------

    /**
     * 下载安装包。
     *
     * 只允许打到本机：手机上的服务端就是这个 App 自己起的那个，
     * 允许任意 URL 等于给了页面一个「下载并安装任意 APK」的口子。
     */
    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url", "");
        final String version = call.getString("version", "").trim();
        final String rawName = call.getString("name", "");
        final String digest = normalizeDigest(call.getString("digest", ""));
        final Long rawSize = call.getLong("size", 0L);
        final long expectSize = rawSize == null ? 0L : rawSize;
        final String notes = call.getString("notes", "");

        if (version.isEmpty()) {
            call.reject("缺少要下载的版本号");
            return;
        }
        if (!isLocalUrl(url)) {
            call.reject("只从本机服务端下载安装包");
            return;
        }
        final String name = safeName(rawName);
        if (!name.toLowerCase(Locale.US).endsWith(".apk")) {
            call.reject("更新包不是 apk：" + rawName);
            return;
        }

        final long myGeneration = generation.incrementAndGet();

        WORKER.execute(() -> {
            final File target = new File(updateDir(), name);
            final File part = new File(updateDir(), name + ".part");
            HttpURLConnection conn = null;
            try {
                // 旧的先清掉：一个包一百多兆，攒几次手机就没空间了
                cleanOldPackages(name);

                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(60_000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/octet-stream");

                int status = conn.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) {
                    String detail = readSome(conn.getErrorStream());
                    throw new Exception("下载更新包失败：HTTP " + status + (detail.isEmpty() ? "" : " " + detail));
                }

                long total = conn.getContentLengthLong();
                if (total <= 0) total = expectSize;
                notifyProgress("download", 0, total);

                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long lastSent = 0;
                try (InputStream in = conn.getInputStream();
                     OutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[64 * 1024];
                    int got;
                    while ((got = in.read(buffer)) != -1) {
                        if (generation.get() != myGeneration) throw new Exception("下载已取消");
                        out.write(buffer, 0, got);
                        sha.update(buffer, 0, got);
                        received += got;
                        long now = System.currentTimeMillis();
                        if (now - lastSent >= 200) {
                            lastSent = now;
                            notifyProgress("download", received, total);
                        }
                    }
                    out.flush();
                }

                String gotDigest = hex(sha.digest());
                if (!digest.isEmpty() && !gotDigest.equals(digest)) {
                    delete(part);
                    throw new Exception("更新包校验失败（下载不完整或被改过），已删除");
                }
                notifyProgress("verify", received, total);

                delete(target);
                if (!part.renameTo(target)) {
                    throw new Exception("下载完成但没能在本地改名，磁盘可能满了");
                }

                JSONObject meta = new JSONObject();
                meta.put("version", version);
                meta.put("name", name);
                meta.put("size", target.length());
                meta.put("digest", digest.isEmpty() ? gotDigest : digest);
                meta.put("notes", notes);
                meta.put("at", System.currentTimeMillis());
                writeMeta(meta);

                JSObject out = new JSObject();
                JSObject ready = readPending(meta);
                if (ready != null) out.put("pending", ready);
                call.resolve(out);
            } catch (Exception error) {
                delete(part);
                call.reject(error.getMessage() == null ? "下载更新包失败" : error.getMessage(), error);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** 只信本机：App 自己起的服务端就在 127.0.0.1 上 */
    private boolean isLocalUrl(String raw) {
        try {
            URL url = new URL(raw);
            String host = url.getHost();
            String protocol = url.getProtocol();
            return ("http".equals(protocol) || "https".equals(protocol))
                && ("127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host));
        } catch (Exception error) {
            return false;
        }
    }

    private void cleanOldPackages(String keepName) {
        File[] files = updateDir().listFiles();
        if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if ("pending.json".equals(name) || "pending.json.tmp".equals(name)) continue;
            if (name.equals(keepName) || name.equals(keepName + ".part")) continue;
            String lower = name.toLowerCase(Locale.US);
            if (lower.endsWith(".apk") || lower.endsWith(".part")) delete(file);
        }
    }

    private void writeMeta(JSONObject meta) throws Exception {
        File tmp = new File(updateDir(), "pending.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(meta.toString().getBytes("UTF-8"));
            out.flush();
        }
        delete(metaFile());
        if (!tmp.renameTo(metaFile())) throw new Exception("安装包已下载，但没记下来");
    }

    private void delete(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /** 松手：用户明确不要这一版了。同时也掐掉正在跑的那个下载 */
    @PluginMethod
    public void discard(PluginCall call) {
        generation.incrementAndGet();
        JSONObject meta = readPendingMeta();
        if (meta != null) delete(new File(updateDir(), safeName(meta.optString("name", ""))));
        delete(metaFile());
        call.resolve();
    }

    // ---------- 安装 ----------

    /**
     * 调起系统安装器。
     *
     * 打开之前先自己把几件事核一遍，把「应用未安装」这种系统级冷话换成能照着做的提示：
     * 权限没开、包不在了、版本不比现在新、签名和现在这份不一致。
     */
    @PluginMethod
    public void install(PluginCall call) {
        JSObject out = new JSObject();
        out.put("started", false);

        if (!canInstallPackages()) {
            out.put("reason", "permission");
            call.resolve(out);
            return;
        }

        JSObject pending = readPending(readPendingMeta());
        if (pending == null) {
            out.put("reason", "missing");
            call.resolve(out);
            return;
        }

        File apk = new File(pending.getString("path", ""));
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
            out.put("reason", "bad");
            call.resolve(out);
            return;
        }
        if (versionCodeOf(archive) <= installedVersionCode()) {
            // 覆盖同一个版本装不上，装个更旧的也装不上 —— 直说，别让系统去说
            out.put("reason", "older");
            call.resolve(out);
            return;
        }
        if (!sameSigner(archive)) {
            out.put("reason", "signature");
            call.resolve(out);
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            out.put("started", true);
            call.resolve(out);
        } catch (Exception error) {
            out.put("reason", "launch");
            call.resolve(out);
        }
    }

    /**
     * 新包和装着的这一份是不是同一个签名。
     *
     * 换了密钥的包系统也会拒绝覆盖安装，但那时弹的是「应用未安装」，没人能从中看出原因。
     * 建两个包的人换了 keystore，自己都常在这一点上兜一圈。
     */
    private boolean sameSigner(PackageInfo archive) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo installed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? pm.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES)
                : pm.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
            String a = signerDigest(installed);
            String b = signerDigest(archive);
            return a.isEmpty() || b.isEmpty() || a.equals(b);
        } catch (Exception error) {
            // 查不出来就别挡路：真装不上时系统会拦
            return true;
        }
    }

    private String signerDigest(PackageInfo info) {
        try {
            Signature[] signatures = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                if (info.signingInfo != null) {
                    signatures = info.signingInfo.hasMultipleSigners()
                        ? info.signingInfo.getApkContentsSigners()
                        : info.signingInfo.getSigningCertificateHistory();
                }
            } else {
                //noinspection deprecation
                signatures = info.signatures;
            }
            if (signatures == null || signatures.length == 0) return "";
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return hex(sha.digest(signatures[0].toByteArray()));
        } catch (Exception error) {
            return "";
        }
    }

    // ---------- 权限 ----------

    /** 「安装未知应用」开没开 */
    @PluginMethod
    public void permission(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", canInstallPackages());
        out.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    @SuppressWarnings("deprecation")
    private boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return getContext().getPackageManager().canRequestPackageInstalls();
        }
        return Settings.Secure.getInt(
            getContext().getContentResolver(),
            Settings.Secure.INSTALL_NON_MARKET_APPS,
            0
        ) == 1;
    }

    /**
     * 把人送到系统那个开关页。
     *
     * 各家 ROM 改过这个页面，路径不一定一样：先按标准入口跳，
     * 跳不成退回「应用详情」，那里也能摸到权限。
     */
    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        JSObject out = new JSObject();
        boolean opened = false;
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            opened = true;
        } catch (Exception error) {
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                opened = true;
            } catch (Exception second) {
                opened = false;
            }
        }
        out.put("opened", opened);
        call.resolve(out);
    }

    // ---------- 小工具 ----------

    private void notifyProgress(String phase, long received, long total) {
        JSObject out = new JSObject();
        out.put("phase", phase);
        out.put("received", received);
        out.put("total", total);
        notifyListeners("progress", out);
    }

    /**
     * 名字来自 GitHub 的资源名，属于外部输入：拼路径前只留文件名。
     *
     * 斜杠分隔的部分先砍掉，再抹掉路径里非法的字符和全部控制字符。
     */
    private String safeName(String raw) {
        String text = raw == null ? "" : raw;
        int slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
        if (slash >= 0) text = text.substring(slash + 1);
        text = text.replaceAll("[\\x00-\\x1f]", "");
        text = text.replaceAll("[\\\\/:*?\"<>|]", "");
        return text.trim();
    }

    private String normalizeDigest(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.US);
        if (value.startsWith("sha256:")) value = value.substring(7);
        return value;
    }

    private String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) builder.append(String.format(Locale.US, "%02x", b));
        return builder.toString();
    }

    private String readSome(InputStream stream) {
        if (stream == null) return "";
        try (InputStream in = stream) {
            byte[] buffer = new byte[256];
            int got = in.read(buffer);
            return got <= 0 ? "" : new String(buffer, 0, got, "UTF-8");
        } catch (Exception error) {
            return "";
        }
    }
}
