// Packages theme/ into a Shopify-uploadable zip (folders at archive root).
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'lyra-kids-atelier.zip');
rmSync(out, { force: true });
execSync(`cd "${resolve(root,'theme')}" && zip -r -q "${out}" . -x "*.DS_Store" "_preview.html"`, { stdio: 'inherit' });
console.log('built', out);
