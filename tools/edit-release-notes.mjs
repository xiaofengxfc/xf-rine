/**
 * 改一条 release 的说明文字（不重传安装包）。
 *
 * 发完之后才发现说明里有个数字写错了，重发一次要再传 250MB —— 这个脚本只改 body。
 * 注意 PATCH 只认 release id：先按 tag 查一次拿到 id，再改。
 *
 * 用法：node tools/edit-release-notes.mjs <tag> <notes-file> <owner/repo>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [tag, notesFile, repo] = process.argv.slice(2);
if (!tag || !notesFile || !repo) {
  console.error('用法：node tools/edit-release-notes.mjs <tag> <notes-file> <owner/repo>');
  process.exit(2);
}

function token() {
  const out = execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  const m = /password=(.+)/.exec(out);
  if (!m) throw new Error('凭据管理器里没有 github.com 的令牌');
  return m[1].trim();
}

const auth = {
  Authorization: 'token ' + token(),
  'User-Agent': 'xf-rine-release',
  Accept: 'application/vnd.github+json',
};

const found = await fetch('https://api.github.com/repos/' + repo + '/releases/tags/' + tag, { headers: auth });
const release = await found.json();
if (!found.ok) {
  console.error('查 release 失败 HTTP ' + found.status + '：' + JSON.stringify(release).slice(0, 300));
  process.exit(1);
}

const res = await fetch('https://api.github.com/repos/' + repo + '/releases/' + release.id, {
  method: 'PATCH',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: readFileSync(notesFile, 'utf8') }),
});
const updated = await res.json();
if (!res.ok) {
  console.error('改说明失败 HTTP ' + res.status + '：' + JSON.stringify(updated).slice(0, 300));
  process.exit(1);
}
console.log('已更新 ' + updated.tag_name + ' 的说明：' + updated.html_url);
