// Copies GSAP from node_modules into the theme's assets so the storefront
// has no third-party CDN dependency (faster + no external point of failure).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'theme/assets');
mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/gsap/dist/gsap.min.js', 'gsap.min.js'],
  ['node_modules/gsap/dist/ScrollTrigger.min.js', 'scroll-trigger.min.js'],
];

for (const [from, to] of files) {
  copyFileSync(resolve(root, from), resolve(out, to));
  console.log('vendored', to);
}
