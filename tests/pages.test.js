import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPages } from '../scripts/build-pages.js';
import express from 'express';
import puppeteer from 'puppeteer';

test('Pages build publishes complete assets under the repository path, never server files or secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tus-pages-'));
  try {
    await buildPages({ directory });
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    assert.ok(html.includes('<base href="/fa-to-rhtus3dev/">'));
    const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:css|js))"/g)].map(match => match[1]);
    assert.ok(assets.length > 10);
    for (const asset of assets) {
      assert.ok(!asset.startsWith('/'), asset);
      assert.ok((await stat(join(directory, asset))).size > 0, asset);
    }
    assert.deepEqual((await readdir(directory)).sort(), ['.nojekyll', '404.html', 'app.js', 'config.js', 'index.html', 'styles.css', 'vendor'].sort());
    const config = await readFile(join(directory, 'config.js'), 'utf8');
    assert.ok(config.includes('"backendConfigured":false'));
    await buildPages({ directory, basePath: '/', apiBaseUrl: 'https://api.example.com/api' });
    assert.ok((await readFile(join(directory, 'config.js'), 'utf8')).includes('https://api.example.com/api'));
    await assert.rejects(buildPages({ directory, apiBaseUrl: 'https://user:secret@example.com/api' }));
    await assert.rejects(buildPages({ directory, basePath: '/unsafe"><script>/' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pages serves styles, fonts and scripts at the project URL on desktop and mobile without API requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tus-pages-browser-'));
  await buildPages({ directory });
  const app = express();
  app.use('/fa-to-rhtus3dev', express.static(directory));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    const failedAssets = [];
    const apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedAssets.push(response.url()); });
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api')) apiRequests.push(request.url()); });
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewport({ width, height });
      await page.goto(`http://127.0.0.1:${server.address().port}/fa-to-rhtus3dev/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#main .stats-grid');
      const layout = await page.evaluate(async () => {
        await document.fonts.ready;
        return { base: new URL(document.baseURI).pathname, sidebar: getComputedStyle(document.querySelector('.sidebar')).position, font: getComputedStyle(document.body).fontFamily, width: innerWidth, scroll: document.documentElement.scrollWidth, icons: document.querySelectorAll('svg').length, exportLoaded: typeof htmlToImage.toPng, signatureLoaded: typeof SignaturePad, status: document.querySelector('#backend-status').textContent };
      });
      assert.equal(layout.base, '/fa-to-rhtus3dev/');
      assert.equal(layout.sidebar, 'fixed');
      assert.ok(layout.font.includes('IBM Plex Sans Arabic'));
      assert.ok(layout.icons > 10);
      assert.equal(layout.exportLoaded, 'function');
      assert.equal(layout.signatureLoaded, 'function');
      assert.ok(layout.status.includes('غير متصل'));
      assert.ok(layout.scroll <= layout.width, `${name} horizontal overflow`);
      await page.click('#theme-button');
      assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), name === 'desktop');
      await page.click('a[data-nav="documents"]');
      await page.waitForSelector('#document-results');
      assert.ok((await page.$eval('#main h1', node => node.textContent)).includes('المستندات'));
      await page.click('#account-button').catch(async () => { await page.click('.mobile-only'); });
      assert.equal(await page.$('.modal'), null);
      await page.waitForSelector('.toast.error');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failedAssets, []);
    assert.deepEqual(apiRequests, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});