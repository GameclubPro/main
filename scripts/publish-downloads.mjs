import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = await import('../package.json', { with: { type: 'json' } });
const { version } = packageJson.default;

const downloadsDir = path.join(rootDir, 'dist', 'downloads');
const artifactBase = `FlexCraft-Launcher-${version}-win-x64`;
const sourceArtifacts = {
  installer: `FlexCraft-Installer-${version}-win-x64.exe`,
  portable: `FlexCraft-Launcher-${version}-portable-win-x64.exe`,
  zip: `${artifactBase}.zip`,
};
const minimumArtifactBytes = 1024 * 1024;

await rm(downloadsDir, { recursive: true, force: true });
await mkdir(downloadsDir, { recursive: true });

async function publishArtifact(sourceName, targetName) {
  const sourcePath = path.join(rootDir, 'release', sourceName);
  const targetPath = path.join(downloadsDir, targetName);
  const sourceStat = await stat(sourcePath).catch(() => null);

  if (!sourceStat?.isFile()) {
    throw new Error(`Missing packaged artifact: ${sourcePath}`);
  }

  if (sourceStat.size < minimumArtifactBytes) {
    throw new Error(`Packaged artifact is suspiciously small (${sourceStat.size} bytes): ${sourcePath}`);
  }

  await copyFile(sourcePath, targetPath);

  console.log(`Published ${targetName} to dist/downloads`);
}

await publishArtifact(sourceArtifacts.installer, 'FlexCraft-Launcher-latest-win-x64.exe');
await publishArtifact(sourceArtifacts.zip, 'FlexCraft-Launcher-latest-win-x64.zip');
await publishArtifact(sourceArtifacts.portable, 'FlexCraft-Launcher-latest-portable-win-x64.exe');

const latestInstallerPath = path.join(downloadsDir, 'FlexCraft-Launcher-latest-win-x64.exe');
const latestInstaller = await readFile(latestInstallerPath);
await writeFile(
  path.join(downloadsDir, 'latest.json'),
  `${JSON.stringify(
    {
      version,
      platform: 'win32',
      arch: 'x64',
      installer: {
        url: 'https://flex-craft.ru/downloads/FlexCraft-Launcher-latest-win-x64.exe',
        fallbackUrls: [
          'https://www.flex-craft.ru/downloads/FlexCraft-Launcher-latest-win-x64.exe',
        ],
        file: 'FlexCraft-Launcher-latest-win-x64.exe',
        sha1: createHash('sha1').update(latestInstaller).digest('hex'),
        size: latestInstaller.byteLength,
        silentArgs: ['/S'],
      },
      publishedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log('Published latest.json to dist/downloads');

process.exitCode = 0;
