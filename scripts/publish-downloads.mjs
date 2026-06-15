import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
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
const compatibilityVersions = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7'];
const minimumArtifactBytes = 1024 * 1024;

await rm(downloadsDir, { recursive: true, force: true });
await mkdir(downloadsDir, { recursive: true });

async function publishArtifact(sourceName, targetName, { hardlink = false } = {}) {
  const sourcePath = path.join(rootDir, 'release', sourceName);
  const targetPath = path.join(downloadsDir, targetName);
  const sourceStat = await stat(sourcePath).catch(() => null);

  if (!sourceStat?.isFile()) {
    throw new Error(`Missing packaged artifact: ${sourcePath}`);
  }

  if (sourceStat.size < minimumArtifactBytes) {
    throw new Error(`Packaged artifact is suspiciously small (${sourceStat.size} bytes): ${sourcePath}`);
  }

  if (hardlink) {
    await link(sourcePath, targetPath).catch(async () => copyFile(sourcePath, targetPath));
  } else {
    await copyFile(sourcePath, targetPath);
  }

  console.log(`Published ${targetName} to dist/downloads`);
}

await publishArtifact(sourceArtifacts.installer, `${artifactBase}.exe`);
await publishArtifact(sourceArtifacts.zip, sourceArtifacts.zip);
await publishArtifact(sourceArtifacts.portable, sourceArtifacts.portable);

await publishArtifact(sourceArtifacts.installer, 'FlexCraft-Launcher-latest-win-x64.exe', { hardlink: true });
await publishArtifact(sourceArtifacts.installer, 'FlexCraft-Launcher-latest.exe', { hardlink: true });
await publishArtifact(sourceArtifacts.zip, 'FlexCraft-Launcher-latest-win-x64.zip', { hardlink: true });
await publishArtifact(sourceArtifacts.portable, 'FlexCraft-Launcher-latest-portable-win-x64.exe', { hardlink: true });

for (const aliasVersion of compatibilityVersions) {
  await publishArtifact(sourceArtifacts.installer, `FlexCraft-Launcher-${aliasVersion}-win-x64.exe`, { hardlink: true });
  await publishArtifact(sourceArtifacts.zip, `FlexCraft-Launcher-${aliasVersion}-win-x64.zip`, { hardlink: true });
  await publishArtifact(sourceArtifacts.portable, `FlexCraft-Launcher-${aliasVersion}-portable-win-x64.exe`, { hardlink: true });
}

process.exitCode = 0;
