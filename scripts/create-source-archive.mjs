import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = await import('../package.json', { with: { type: 'json' } });
const archiveName = `flexcraft-launcher-source-${packageJson.default.version}.zip`;
const archivePath = path.join(rootDir, archiveName);

const includePaths = [
  '.gitignore',
  'index.html',
  'package-lock.json',
  'package.json',
  'README.md',
  'run-windows.cmd',
  'setup-windows.cmd',
  'tsconfig.json',
  'vite.config.ts',
  'electron',
  'public',
  'scripts',
  'src',
  'tools',
];

const archiveEntries = {};

async function addToArchive(relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  const itemStat = await stat(fullPath);

  if (itemStat.isDirectory()) {
    const children = await readdir(fullPath);
    for (const child of children) {
      await addToArchive(path.join(relativePath, child));
    }
    return;
  }

  if (!itemStat.isFile()) {
    return;
  }

  archiveEntries[relativePath.replaceAll(path.sep, '/')] = await readFile(fullPath);
}

for (const relativePath of includePaths) {
  await addToArchive(relativePath);
}

await writeFile(archivePath, zipSync(archiveEntries, { level: 6 }));

console.log(`Created ${archivePath}`);
process.exitCode = 0;
