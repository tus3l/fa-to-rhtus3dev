import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { buildPages } from './build-pages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildVercel({ directory = resolve(root, 'public') } = {}) {
  await buildPages({ directory, basePath: '/', staticHosting: false });
  for (const file of ['404.html', '.nojekyll']) await rm(resolve(directory, file));
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildVercel();
  console.log('Vercel public assets built in public/');
}