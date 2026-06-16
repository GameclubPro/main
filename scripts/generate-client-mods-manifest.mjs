import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modsDir = path.join(rootDir, 'public', 'client-mods', 'mods');
const manifestPath = path.join(modsDir, '.craftgate-client-mods.json');

const existingManifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
const previousMods = new Map(
  (Array.isArray(existingManifest.mods) ? existingManifest.mods : [])
    .filter((mod) => mod && typeof mod.file === 'string')
    .map((mod) => [mod.file, mod]),
);

const jarFiles = (await readdir(modsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((fileName) => fileName.toLowerCase().endsWith('.jar'))
  .sort((left, right) => left.localeCompare(right, 'en'));

const mods = [];
for (const file of jarFiles) {
  const filePath = path.join(modsDir, file);
  const fileBuffer = await readFile(filePath);
  const fileStat = await stat(filePath);
  mods.push({
    ...(previousMods.get(file) ?? {}),
    file,
    size: fileStat.size,
    sha1: createHash('sha1').update(fileBuffer).digest('hex'),
  });
}

const manifest = {
  ...existingManifest,
  updatedAt: existingManifest.updatedAt ?? new Date().toISOString(),
  mods,
};

delete manifest.source;
delete manifest.syncedAt;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Updated ${path.relative(rootDir, manifestPath)} with ${mods.length} mods.`);
