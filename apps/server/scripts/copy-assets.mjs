import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist/site/assets'), { recursive: true });
cpSync(join(root, 'src/site/assets'), join(root, 'dist/site/assets'), { recursive: true });
console.log('Copied site assets');
