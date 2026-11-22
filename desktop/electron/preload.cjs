'use strict';
/**
 * 页面对外壳的唯一入口。
 *
 * 页面本身还是普通网页（contextIsolation 开着、没有 Node），这里只开一个窄口子：
 * 版本号、平台，以及「下载并安装更新」这一件事。
 * 写临时目录、起安装器、退出程序都不该让页面自己干。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 版本号由主进程用 additionalArguments 传进来：preload 里拿不到 app 对象 */
const PREFIX = '--xf-version=';
const arg = process.argv.find((item) => item.startsWith(PREFIX)) ?? '';
const version = arg.slice(PREFIX.length);

contextBridge.exposeInMainWorld('xfDesktop', {
  version,
  platform: 'win',
  update: {
    /**
     * 开始下载并安装。
     *
     * 参数是查更新时拿到的资源信息（版本、文件名、大小、sha256）。
     * 安装成功时这个 Promise 多半来不及回话 —— 程序会先退出，
     * 页面那边按「已进入安装」处理就行。
     */
    start(payload) {
      return ipcRenderer.invoke('update:start', {
        version: String(payload?.version ?? ''),
        name: String(payload?.name ?? ''),
        size: Number(payload?.size) || 0,
        digest: String(payload?.digest ?? ''),
      });
    },
    /** 订阅下载与安装进度，返回取消订阅的函数 */
    onProgress(callback) {
      const handler = (_event, progress) => {
        try {
          callback(progress);
        } catch {
          /* 页面自己的错不该把主进程拖下水 */
        }
      };
      ipcRenderer.on('update:progress', handler);
      return () => ipcRenderer.removeListener('update:progress', handler);
    },
  },
});
