import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const files = [
  'index.html',
  'style.css',
  'main.js',
  'icon.svg',
  'starfield.js',
  'sky-motion.js',
  'fonts/instrument-sans-500-latin.woff2',
  'fonts/InstrumentSans-OFL.txt',
];
await mkdir(new URL('dist/fonts/', root), { recursive: true });
for (const name of files) {
  await copyFile(new URL(name, root), new URL(`dist/${name}`, root));
}
console.log('Built Asterveil website → dist/');
