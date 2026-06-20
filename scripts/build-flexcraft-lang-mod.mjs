import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'client-mods', 'flexcraft-ru-lang');
const outputPath = path.join(rootDir, 'public', 'client-mods', 'mods', 'flexcraft-ru-lang-1.0.0.jar');
const fixedMtime = new Date('2026-01-01T00:00:00.000Z');

async function collectFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = {};

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(absolutePath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files[relativePath] = [await readFile(absolutePath), { mtime: fixedMtime }];
    }
  }

  return files;
}

const files = await collectFiles(sourceDir);
const openPacAssetsLang = 'assets/openpartiesandclaims/lang/ru_ru.json';
const openPacDataLang = 'data/openpartiesandclaims/lang/ru_ru.json';

if (files[openPacAssetsLang] && !files[openPacDataLang]) {
  files[openPacDataLang] = files[openPacAssetsLang];
}

await writeFile(outputPath, Buffer.from(zipSync(files, { level: 9 })));
console.log(`Built ${path.relative(rootDir, outputPath)} with ${Object.keys(files).length} files.`);
