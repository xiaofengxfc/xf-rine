import { decideUpdate, type UpdateCheck } from '../src/lib/update.ts';

/**
 * 启动时该弹哪个弹窗的自检。
 *
 * 这段判断决定三件事：刚装完要弹「这次更新了什么」、有没有新版、以及该把哪个版本记下来。
 * 判错了的表现都不好看：升级完不吭声，或者每次启动都说「刚更新完」。
 */

const checks: [string, boolean][] = [];
const eq = (name: string, passed: boolean) => checks.push([name, passed]);

const release = (version: string, notes = version + ' 的说明') => ({
  version,
  notes,
  publishedAt: '2026-11-22T00:00:00Z',
  asset: { name: 'XunFeng-' + version + '-Setup.exe', size: 1, digest: 'sha256:aa' },
});

const makeResult = (input: {
  current: string;
  latest?: ReturnType<typeof release> | null;
  selfNotes?: string;
  enabled?: boolean;
}): UpdateCheck => ({
  enabled: input.enabled ?? true,
  current: input.current,
  latest: input.latest ?? null,
  self: input.selfNotes === undefined ? null : { version: input.current, notes: input.selfNotes },
});

// ---- 刚装完：本地那份说明优先，离线也认 ----
const installedNow = decideUpdate({
  installed: '1.2.4',
  pending: { version: '1.2.4', notes: '这一版改了什么' },
  seen: '1.2.3',
  result: null,
});
eq('装完且版本对得上：弹「已更新」', installedNow.mode === 'updated');
eq('装完：用的是本地存的说明', installedNow.info?.self?.notes === '这一版改了什么');
eq('装完：把新版本记下来', installedNow.remember === '1.2.4');
eq('装完：这一轮不再提示下一版', installedNow.after === null);

const installFailed = decideUpdate({
  installed: '1.2.3',
  pending: { version: '1.2.4', notes: '这一版改了什么' },
  seen: '1.2.3',
  result: makeResult({ current: '1.2.3', latest: release('1.2.4') }),
});
eq('安装没成功（版本没变）：不谎报已更新', installFailed.mode === 'available');
eq('安装没成功：仍然提示有新版', installFailed.info?.latest?.version === '1.2.4');

// ---- 联网查到的情况 ----
const upgraded = decideUpdate({
  installed: '1.2.4',
  seen: '1.2.3',
  result: makeResult({ current: '1.2.4', selfNotes: '这一版改了什么' }),
});
eq('服务端说当前版本比上次新：弹「已更新」', upgraded.mode === 'updated');
eq('刚升级完这一轮也不叠加提示下一版', upgraded.after === null);

const upgradedAndNewer = decideUpdate({
  installed: '1.2.4',
  seen: '1.2.3',
  result: makeResult({ current: '1.2.4', latest: release('1.2.5'), selfNotes: '1.2.4 说明' }),
});
eq('刚升级完、又出了更新的：关掉后接着提示', upgradedAndNewer.mode === 'updated' && upgradedAndNewer.after?.latest?.version === '1.2.5');

const firstRun = decideUpdate({
  installed: '1.2.3',
  seen: '',
  result: makeResult({ current: '1.2.3', latest: release('1.2.4') }),
});
eq('第一次装（没有记录）：不弹「已更新」', firstRun.mode === 'available');
eq('第一次装：记下当前版本', firstRun.remember === '1.2.3');

const upToDate = decideUpdate({
  installed: '1.2.3',
  seen: '1.2.3',
  result: makeResult({ current: '1.2.3' }),
});
eq('已经是最新：什么都不弹', upToDate.mode === 'none');

const noToken = decideUpdate({ installed: '1.2.3', seen: '1.2.3', result: makeResult({ current: '1.2.3', enabled: false }) });
eq('没配令牌（检查被禁用）：什么都不弹', noToken.mode === 'none');

const offline = decideUpdate({ installed: '1.2.3', seen: '1.2.3', result: null });
eq('查更新失败：什么都不弹', offline.mode === 'none' && offline.info === null);

const oldSeen = decideUpdate({
  installed: '1.2.2',
  seen: '1.0.0',
  result: makeResult({ current: '1.2.2', selfNotes: '累计变更' }),
});
eq('跨了几个版本升级：弹当前这版的说明', oldSeen.mode === 'updated' && oldSeen.info?.self?.notes === '累计变更');

const noNotes = decideUpdate({
  installed: '1.2.4',
  seen: '1.2.3',
  result: makeResult({ current: '1.2.4', selfNotes: '' }),
});
eq('这一版没写说明：仍然告诉用户已经升上来了', noNotes.mode === 'updated');

let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log('  ✓ ' + name);
  else { failures += 1; console.error('  ✗ ' + name); }
}
if (failures) {
  console.error('✗ 更新提示判断失败 ' + failures + '/' + checks.length);
  process.exit(1);
}
console.log('✓ 更新提示判断全部通过（' + checks.length + ' 项）');
