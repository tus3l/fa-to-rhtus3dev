import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createApp, createPublicHandler } from '../server.js';
import { buildVercel } from '../scripts/build-vercel.js';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

async function serve(handler, check) {
  const app = express();
  app.use(handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('public handler fails closed without configuration and never creates local files', async () => {
  let created = 0;
  await serve(createPublicHandler({ environment: {}, applicationFactory: () => { created++; throw new Error('must not run'); } }), async origin => {
    const response = await fetch(`${origin}/api/session`);
    assert.equal(response.status, 503);
    assert.ok((await response.json()).error.includes('DATABASE_URL'));
    assert.equal(created, 0);
  });
});

test('public handler initializes once and serves the existing API after database readiness', async () => {
  let created = 0;
  let application;
  const environment = { DATABASE_URL: 'postgresql://configured.example/database', LINK_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
  const handler = createPublicHandler({ environment, applicationFactory: () => {
    created++;
    application = createApp({ dbPath: ':memory:', encryptionKey: randomBytes(32) });
    return application;
  } });
  try {
    await serve(handler, async origin => {
      assert.equal((await fetch(`${origin}/api/health`)).status, 200);
      const response = await fetch(`${origin}/api/session`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).setupRequired, true);
      assert.equal(created, 1);
    });
  } finally { await application?.store.close(); }
});

test('public handler closes a failed store and retries initialization without exposing errors', async () => {
  let created = 0;
  let closed = 0;
  const app = express();
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  const handler = createPublicHandler({
    environment: { DATABASE_URL: 'postgresql://configured.example/database', LINK_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
    applicationFactory: () => {
      created++;
      return { app, ready: created === 1 ? Promise.reject(new Error('private database error')) : Promise.resolve(), store: { close: async () => { closed++; } } };
    }
  });
  await serve(handler, async origin => {
    const failed = await fetch(`${origin}/api/health`);
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes('private database error'));
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal(created, 2);
    assert.equal(closed, 1);
  });
});

test('Vercel public assets use same-origin API, render settings without WhatsApp and export an approved invoice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tus-vercel-'));
  let browser;
  try {
    await buildVercel({ directory });
    assert.deepEqual((await readdir(directory)).sort(), ['app.js', 'config.js', 'index.html', 'styles.css', 'vendor'].sort());
    const config = await readFile(join(directory, 'config.js'), 'utf8');
    assert.ok(config.includes('"apiBaseUrl":"/api"'));
    assert.ok(config.includes('"staticHosting":false'));
    assert.ok(config.includes('"backendConfigured":true'));
    const app = express();
    app.get('/sign/:token', (req, res) => res.sendFile(join(directory, 'index.html')));
    app.use(express.static(directory));
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    const failedAssets = [];
    const whatsappRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedAssets.push(response.url()); });
    await page.setRequestInterception(true);
    const party = { name: 'عميل الاختبار', phone: '', company: '', email: '', website: '', taxId: '', notes: '' };
    const signature = await sharp({ create: { width: 200, height: 80, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.alloc(100 * 5 * 3, 30), raw: { width: 100, height: 5, channels: 3 }, left: 20, top: 30 }]).png().toBuffer();
    const approved = { number: 'TUS-2026-00001', status: 'Approved', revision: 1, approved_at: '2026-10-11T10:00:00Z', signature: { image: `data:image/png;base64,${signature.toString('base64')}`, signer_name: party.name, signed_at: '2026-10-11T10:00:00Z' }, content: { type: 'invoice', title: 'فاتورة مشروع', date: '2026-10-11', provider: { ...party, name: 'مقدم الخدمة' }, client: party, items: [{ name: 'تطوير موقع', quantity: 1, price: 200, discount: 0 }], payments: [], currency: 'SAR', accent: '#28765a', declaration: 'تمت مراجعة جميع المعلومات واعتمادها.' } };
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/whatsapp')) whatsappRequests.push(path);
      const fixtures = {
        '/api/session': { user: { id: 'test', name: party.name, email: 'test@example.com' }, csrf: 'test-csrf', setupRequired: false },
        '/api/settings': { provider: party, banks: [], declarations: {}, logo: '', accent: '#28765a', numberPrefix: 'TUS' },
        '/api/documents': [], '/api/clients': [], '/api/sign/test-token': approved
      };
      if (path in fixtures) void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[path]) });
      else void request.continue();
    });
    await mkdir('test-results', { recursive: true });
    await serve(app, async origin => {
      for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
        await page.setViewport({ width, height });
        await page.goto(`${origin}/index.html#settings`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('#settings-form');
        assert.equal(await page.$('#whatsapp-connect'), null);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `test-results/vercel-settings-${name}.png`, fullPage: true });
      }
      await page.goto(`${origin}/sign/test-token`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.document-paper');
      const image = await page.evaluate(async () => {
        await document.fonts.ready;
        return htmlToImage.toPng(document.querySelector('.document-paper'), { pixelRatio: 1 });
      });
      const stats = await sharp(Buffer.from(image.split(',')[1], 'base64')).stats();
      assert.ok(stats.channels.some(channel => channel.stdev > 15));
      assert.deepEqual(errors, []);
      assert.deepEqual(failedAssets, []);
      assert.deepEqual(whatsappRequests, []);
    });
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Vercel rejects local persistence and public owner bootstrap behind its HTTPS proxy', async () => {
  const keys = ['VERCEL', 'DATABASE_PROVIDER', 'DATABASE_URL', 'LINK_ENCRYPTION_KEY', 'NODE_ENV'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { VERCEL: '1', DATABASE_PROVIDER: 'supabase', DATABASE_URL: 'postgresql://configured.example/database', LINK_ENCRYPTION_KEY: randomBytes(32).toString('hex'), NODE_ENV: 'production' });
    assert.throws(() => createApp({ dbPath: ':memory:' }), /external PostgreSQL/);
    delete process.env.LINK_ENCRYPTION_KEY;
    assert.throws(() => createApp(), /stable LINK_ENCRYPTION_KEY/);
    process.env.LINK_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const application = createApp({ store: { dialect: 'postgres', ready: async () => {} } });
    assert.equal(application.app.get('trust proxy'), 1);
    await serve(application.app, async origin => {
      const response = await fetch(`${origin}/api/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' }, body: '{}'
      });
      assert.equal(response.status, 403);
      assert.ok((await response.json()).error.includes('المالك'));
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});