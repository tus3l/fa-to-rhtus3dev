import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPages({ directory = resolve(root, 'dist'), basePath = '/fa-to-rhtus3dev/', apiBaseUrl = '', staticHosting = true } = {}) {
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*$/.test(basePath)) throw new Error('Use a base path such as /repository/ or /');
  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS API URL without credentials');
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const file of ['styles.css', 'app.js']) await cp(resolve(root, file), resolve(directory, file));
  const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace('<base href="/">', `<base href="${basePath}">`);
  await writeFile(resolve(directory, 'index.html'), html);
  await writeFile(resolve(directory, '404.html'), html);
  const config = { apiBaseUrl: apiBaseUrl || '/api', staticHosting, backendConfigured: !staticHosting || Boolean(apiBaseUrl) };
  await writeFile(resolve(directory, 'config.js'), `globalThis.TUS3DEV_CONFIG = Object.freeze(${JSON.stringify(config).replaceAll('<', '\\u003c')});\n`);
  await writeFile(resolve(directory, '.nojekyll'), '');
  const vendors = [
    ['lucide/dist/umd', 'lucide'],
    ['signature_pad/dist', 'signature'],
    ['html-to-image/dist', 'export'],
    ['@fontsource/ibm-plex-sans-arabic', 'fonts/arabic'],
    ['@fontsource/manrope', 'fonts/latin']
  ];
  for (const [source, destination] of vendors) await cp(resolve(root, 'node_modules', source), resolve(directory, 'vendor', destination), { recursive: true });
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'fa-to-rhtus3dev';
  await buildPages({ basePath: process.env.PAGES_BASE_PATH || `/${repository}/`, apiBaseUrl: process.env.PAGES_API_BASE_URL || '' });
  console.log('GitHub Pages assets built in dist/');
}