import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const repo = resolve(mobile, '..');
const resources = join(mobile, 'resources');
const androidRes = join(mobile, 'android/app/src/main/res');
const require = createRequire(import.meta.url);
const assetsEntry = require.resolve('@capacitor/assets');
const sharp = require(require.resolve('sharp', { paths: [dirname(assetsEntry)] }));
const icon = join(resources, 'icon.png');

const iconSvg = readFileSync(join(repo, 'web/public/icon.svg'), 'utf8').replace(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"',
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"',
);
await sharp(Buffer.from(iconSvg)).resize(1024, 1024).png().toFile(icon);

const densities = [
  ['ldpi', 36, 81],
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

const foreground = Buffer.from(readFileSync(join(resources, 'android/icon-foreground.svg')));
const background = Buffer.from(readFileSync(join(resources, 'android/icon-background.svg')));

for (const [density, launcherSize, adaptiveSize] of densities) {
  const directory = join(androidRes, `mipmap-${density}`);
  mkdirSync(directory, { recursive: true });

  const launcher = await sharp(icon).resize(launcherSize, launcherSize).png().toBuffer();
  const roundMask = Buffer.from(
    `<svg width="${launcherSize}" height="${launcherSize}"><circle cx="${launcherSize / 2}" cy="${launcherSize / 2}" r="${launcherSize / 2}" fill="#fff"/></svg>`,
  );
  await sharp(launcher).composite([{ input: roundMask, blend: 'dest-in' }])
    .png().toFile(join(directory, 'ic_launcher_round.png'));
  await sharp(launcher).toFile(join(directory, 'ic_launcher.png'));

  await sharp(foreground).resize(adaptiveSize, adaptiveSize).png()
    .toFile(join(directory, 'ic_launcher_foreground.png'));
  await sharp(background).resize(adaptiveSize, adaptiveSize).png()
    .toFile(join(directory, 'ic_launcher_background.png'));
}

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
const adaptiveDirectory = join(androidRes, 'mipmap-anydpi-v26');
mkdirSync(adaptiveDirectory, { recursive: true });
writeFileSync(join(adaptiveDirectory, 'ic_launcher.xml'), adaptiveIcon);
writeFileSync(join(adaptiveDirectory, 'ic_launcher_round.xml'), adaptiveIcon);

console.log('Android launcher icons generated without white inset layers.');
