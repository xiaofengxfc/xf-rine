import {
  checkUpdate,
  compareVersions,
  latestFor,
  normalizeReleases,
  parseVersion,
  pickAsset,
  type Release,
} from '../src/update.js';

/**
 * 更新检查的自检：版本比较、挑安装包、以及「该不该提示」。
 *
 * 全走注入的数据，不连网 —— 更新这块最容易错在判断上，
 * 判断错了的后果是「装了旧包」或者「一直提示同一个更新」。
 */

const checks: [string, boolean][] = [];
const eq = (name: string, passed: boolean) => checks.push([name, passed]);

// ---- 版本号 ----
eq('1.2.3 比 1.2.4 旧', compareVersions('1.2.3', '1.2.4') === -1);
eq('1.2.10 比 1.2.9 新（按数字比，不是按字符串）', compareVersions('1.2.10', '1.2.9') === 1);
eq('带 v 前缀和纯数字相等', compareVersions('v1.2.3', '1.2.3') === 0);
eq('1.3 比 1.2.9 新', compareVersions('1.3', '1.2.9') === 1);
eq('后缀不当成版本高低（1.2.3-beta 和 1.2.3 同类）', compareVersions('1.2.3-beta.1', '1.2.3') === 0);
eq('预发布后缀拆掉', JSON.stringify(parseVersion('v2.0.1-beta.2')) === JSON.stringify([2, 0, 1]));

// ---- 挑平台资源 ----
const assets = [
  { id: 11, name: 'XunFeng-1.2.4-arm64.apk', size: 70_000_000, digest: 'sha256:aaaa' },
  { id: 12, name: 'XunFeng-1.2.4-Setup.exe', size: 180_000_000, digest: 'sha256:bbbb' },
];
eq('桌面挑 Setup.exe', pickAsset(assets, 'win')?.id === 12);
eq('安卓挑 apk', pickAsset(assets, 'android')?.id === 11);
eq('没有对应平台的包就返回 null', pickAsset([assets[1]!], 'android') === null);

// ---- GitHub 返回值的收拢 ----
const normalized = normalizeReleases([
  {
    tag_name: 'v1.2.4',
    body: '### 1.2.4\n- 修了什么',
    published_at: '2026-11-22T00:00:00Z',
    draft: false,
    prerelease: false,
    assets,
  },
  { tag_name: '' },
  null,
  { tag_name: 'v1.2.5', assets: [{ id: '不是数字', name: 'x.exe' }, { id: 3, name: 'y.exe' }] },
]);
eq('标签去掉 v', normalized[0]?.version === '1.2.4');
eq('说明原样保留', normalized[0]?.notes.includes('修了什么') === true);
eq('脏条目被丢掉、坏资源被丢掉', normalized.length === 2 && normalized[1]?.assets.length === 1);
eq('不是数组时返回空', normalizeReleases({}) .length === 0);

// ---- 挑最新一版 ----
const release = (version: string, extra: Partial<Release> = {}): Release => ({
  version,
  notes: version + ' 的说明',
  publishedAt: '2026-11-22T00:00:00Z',
  assets,
  ...extra,
});
const list: Release[] = [
  release('1.2.2'),
  release('1.2.3'),
  release('1.2.5', { draft: true }),
  release('1.2.6', { prerelease: true }),
  release('1.2.4'),
];
eq('当前 1.2.2：挑到 1.2.4，跳过草稿和预发布', latestFor(list, '1.2.2', 'win')?.version === '1.2.4');
eq('已经是最新：没有可装的版本', latestFor(list, '1.2.4', 'win') === null);
eq('比最新还新（开发版）：不提示降级', latestFor(list, '1.3.0', 'win') === null);
eq('只有 apk 的版本，桌面端不提示', latestFor([release('1.2.4', { assets: [assets[0]!] })], '1.2.2', 'win') === null);

// ---- 该提示什么 ----
const withToken = await checkUpdate({ current: '1.2.2', platform: 'win', releases: list, token: 't' });
eq('有新版：带版本号', withToken.latest?.version === '1.2.4');
eq('有新版：带更新说明', (withToken.latest?.notes ?? '').includes('1.2.4 的说明'));
eq('有新版：带安装包信息和 sha256', withToken.latest?.asset.digest === 'sha256:bbbb');

const upToDate = await checkUpdate({ current: '1.2.4', platform: 'win', releases: list, token: 't' });
eq('已是最新：不提示', upToDate.latest === null);
eq('已是最新：能查到这一版的说明（升级完要弹的就是它）', upToDate.self?.notes === '1.2.4 的说明');

const noToken = await checkUpdate({ current: '1.2.3', platform: 'win', token: '' });
eq('没配令牌：不查也不提示', noToken.enabled === false && noToken.latest === null);
eq('没配令牌：说清原因', noToken.error === 'UPDATE_TOKEN_MISSING');

const android = await checkUpdate({ current: '1.2.2', platform: 'android', releases: list, token: 't' });
eq('安卓拿的是 apk', android.latest?.asset.name.endsWith('.apk') === true);

let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}

if (failures) {
  console.error('✗ 更新检查自检失败 ' + failures + '/' + checks.length);
  process.exit(1);
}
console.log('✓ 更新检查全部通过（' + checks.length + ' 项）');
