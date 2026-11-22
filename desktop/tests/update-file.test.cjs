'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeInstallerName } = require('../electron/update-file.cjs');

/** 更新包文件名来自 GitHub Release，是外部输入，拼路径前要过这一道 */

test('正常名字原样保留', () => {
  assert.equal(safeInstallerName('XunFeng-1.2.4-Setup.exe', '1.2.4'), 'XunFeng-1.2.4-Setup.exe');
});

test('带目录的只留最后一段', () => {
  assert.equal(safeInstallerName('..\\..\\Windows\\evil.exe', '1.2.4'), 'evil.exe');
  assert.equal(safeInstallerName('/tmp/x/XunFeng-Setup.exe', '1.2.4'), 'XunFeng-Setup.exe');
});

test('没给名字时按版本兜底', () => {
  assert.equal(safeInstallerName('', '1.2.4'), 'XunFeng-1.2.4-Setup.exe');
  assert.equal(safeInstallerName(undefined, '1.2.4'), 'XunFeng-1.2.4-Setup.exe');
});

test('去掉 Windows 不允许的字符', () => {
  assert.equal(safeInstallerName('XunFeng:1*2?3"4<5>6|7.exe', '1.2.4'), 'XunFeng1234567.exe');
});

test('版本号里的杂字符不会带进兜底名字', () => {
  assert.equal(safeInstallerName('', '../1.2.4'), 'XunFeng-..1.2.4-Setup.exe');
});
