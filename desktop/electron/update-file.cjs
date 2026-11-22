'use strict';
/**
 * 更新包落在哪、叫什么。
 *
 * 单独一个文件是为了能单测：主进程那个文件一 require 就要 Electron 运行时。
 * 文件名来自 GitHub Release 的资源名，属于外部输入 —— 拼路径之前必须只留文件名，
 * 否则一个带 ..\ 的名字就能写到临时目录外面去。
 */

/**
 * @param {string} name Release 里给的资源名
 * @param {string} version 要装的版本，用来在没给名字时兜底
 */
function safeInstallerName(name, version) {
  const raw = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  if (cleaned) return cleaned;
  return 'XunFeng-' + String(version ?? '').replace(/[^0-9A-Za-z._-]/g, '') + '-Setup.exe';
}

module.exports = { safeInstallerName };
