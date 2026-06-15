import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'dist-electron');

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'package.json'), '{\n  "type": "commonjs"\n}\n', 'utf8');
