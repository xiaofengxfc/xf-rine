/**
 * 发布 GitHub Release v1.3.0：建 release、传两个安装包。
 *
 * 单独写成脚本，是为了避开 PowerShell 引号/JSON 序列化那堆坑（上一次实测：
 * 用 ConvertTo-Json 拼 body 会把请求体撑到 448KB，GitHub 直接 422）。
 * 令牌从 git credential manager 里现取，只在这个进程里用，不打印、不落盘。
 *
 * 用法：node tools/publish-release.mjs <tag> <notes-file> <owner/repo> <file...>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [tag, notesFile, repo, ...files] = process.argv.slice(2);
if (!tag || !notesFile || !repo || files.length === 0) {
  console.error('用法：node tools/publish-release.mjs <tag> <notes-file> <owner/repo> <file...>');
  process.exit(2);
}

/** 从凭据管理器里取一个 GitHub 令牌（只读用户名，不打印密码） */
function token() {
  const helper = process.platform === 'win32' ? 'git.exe' : 'git';
  const out = execFileSync(helper, ['credential', 'fill'], {
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

const api = 'https://api.github.com/repos/' + repo;

async function main() {
  const notes = readFileSync(notesFile, 'utf8');
  const create = await fetch(api + '/releases', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: tag,
      body: notes,
      draft: false,
      prerelease: false,
    }),
  });
  const release = await create.json();
  if (!create.ok) {
    console.error('建 release 失败 HTTP ' + create.status + '：' + JSON.stringify(release).slice(0, 400));
    process.exit(1);
  }
  console.log('release id=' + release.id + ' tag=' + release.tag_name);
  console.log(release.html_url);

  for (const file of files) {
    const name = basename(file);
    const body = readFileSync(file);
    console.log('上传 ' + name + '（' + (body.length / 1048576).toFixed(1) + ' MB）…');
    const started = Date.now();
    const res = await fetch(
      'https://uploads.github.com/repos/' + repo + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name),
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
        body,
      },
    );
    const asset = await res.json();
    if (!res.ok) {
      console.error('传 ' + name + ' 失败 HTTP ' + res.status + '：' + JSON.stringify(asset).slice(0, 300));
      process.exit(1);
    }
    console.log('  ok ' + asset.name + ' ' + asset.size + ' bytes 用时 ' + Math.round((Date.now() - started) / 1000) + 's');
  }
  console.log('全部完成');
}

main().catch((error) => {
  console.error('失败：' + (error?.message ?? error));
  process.exit(1);
});
