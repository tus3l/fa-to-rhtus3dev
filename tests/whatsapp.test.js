import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhatsappService, whatsappNumber, approvalCaption } from '../whatsapp.js';
import { createInvoiceRenderer } from '../invoice-image.js';
import { createApp } from '../server.js';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';

const document = { number: 'TUS-2026-00001', status: 'Approved', signature: { image: 'signature' }, content: { client: { name: 'Client', phone: '0501234567' } } };

test('WhatsApp normalizes Saudi and international numbers and rejects invalid ones', () => {
  for (const input of ['0501234567', '+966501234567', '00966501234567', '966501234567', '٠٥٠١٢٣٤٥٦٧']) assert.equal(whatsappNumber(input), '966501234567');
  assert.equal(whatsappNumber('+447911123456'), '447911123456');
  for (const input of ['', '123', 'not a phone']) assert.throws(() => whatsappNumber(input));
});

test('WhatsApp persists offline jobs, sends caption with image once, and requires explicit retry on uncertain delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tus-whatsapp-'));
  const sent = [];
  const client = new EventEmitter();
  client.initialize = async () => { client.emit('qr', 'test-qr'); };
  client.destroy = async () => {};
  client.getNumberId = async phone => ({ _serialized: `${phone}@c.us` });
  client.sendImage = async (...args) => { sent.push(args); return { id: { _serialized: 'message-id' } }; };
  const options = { directory, renderImage: async () => Buffer.from('invoice-image'), clientFactory: async () => client, qrImage: async () => 'data:image/png;base64,test' };
  let service = createWhatsappService(options);
  try {
    await assert.rejects(service.enqueue('draft', { ...document, status: 'Draft' }));
    await service.enqueue('document-1', document);
    assert.equal((await service.status()).jobs[0].status, 'pending');
    assert.equal(sent.length, 0);
    await service.close();
    service = createWhatsappService(options);
    await service.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await service.status()).status, 'qr');
    client.emit('ready');
    await service.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], '966501234567@c.us');
    assert.equal(sent[0][1].toString(), 'invoice-image');
    assert.equal(sent[0][3], approvalCaption);
    assert.equal((await service.status()).jobs[0].status, 'sent');
    await service.enqueue('document-1', document);
    await service.flush();
    assert.equal(sent.length, 1);
    client.sendImage = async () => { throw new Error('network lost'); };
    await service.enqueue('document-2', document);
    await service.flush();
    assert.equal((await service.status()).jobs.find(job => job.id === 'document-2').status, 'uncertain');
    await service.flush();
    await service.enqueue('document-3', { ...document, content: { client: { name: 'Client', phone: '' } } });
    assert.equal((await service.status()).jobs.find(job => job.id === 'document-3').status, 'failed');
    client.sendImage = async (...args) => { sent.push(args); return {}; };
    await service.retry('document-3', '+966501234567');
    await service.flush();
    assert.equal(sent.length, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test('approved invoice renders a nonblank PNG and WhatsApp settings fit desktop and mobile', async () => {
  const application = createApp({ dbPath: ':memory:', encryptionKey: randomBytes(32) });
  await application.ready;
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const renderer = createInvoiceRenderer({ origin: () => origin });
  let browser;
  try {
    const signature = await sharp({ create: { width: 200, height: 80, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.alloc(100 * 5 * 3, 30), raw: { width: 100, height: 5, channels: 3 }, left: 20, top: 30 }]).png().toBuffer();
    const party = { name: 'عميل الاختبار', phone: '0501234567', company: '', email: '', website: '', taxId: '' };
    const approved = { ...document, revision: 1, approved_at: '2026-10-11T10:00:00Z', signature: { image: `data:image/png;base64,${signature.toString('base64')}`, signer_name: party.name, signed_at: '2026-10-11T10:00:00Z' }, content: { type: 'invoice', title: 'فاتورة مشروع', date: '2026-10-11', provider: { ...party, name: 'مقدم الخدمة' }, client: party, items: [{ name: 'تطوير موقع', quantity: 1, price: 200, discount: 0 }], payments: [], currency: 'SAR', accent: '#28765a', declaration: 'تمت مراجعة جميع المعلومات واعتمادها.' } };
    const image = await renderer.render(approved);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1588);
    assert.ok(metadata.height >= 2246);
    const stats = await sharp(image).stats();
    assert.ok(stats.channels.some(channel => channel.stdev > 15));
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const qr = await QRCode.toDataURL('test-only-qr');
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const fixtures = {
        '/api/session': { user: { id: 'test', name: party.name, email: 'test@example.com' }, csrf: 'test-csrf', setupRequired: false },
        '/api/settings': { provider: party, banks: [], declarations: {}, logo: '', accent: '#28765a', numberPrefix: 'TUS' },
        '/api/documents': [], '/api/clients': [],
        '/api/whatsapp': { status: 'qr', qr, jobs: [{ id: 'test-doc', number: document.number, clientName: party.name, status: 'failed', phone: '', error: 'رقم العميل غير صالح' }] }
      };
      if (path in fixtures) void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[path]) });
      else void request.continue();
    });
    await mkdir('test-results', { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewport({ width, height });
      await page.goto(`${origin}/index.html#settings`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#whatsapp-qr img');
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, imageWidth: document.querySelector('#whatsapp-qr img').getBoundingClientRect().width }));
      assert.ok(layout.scroll <= layout.width, `${name} horizontal overflow`);
      assert.ok(layout.imageWidth > 150 && layout.imageWidth <= 280);
      await page.screenshot({ path: `test-results/whatsapp-${name}.png`, fullPage: true });
    }
    await page.click('[data-whatsapp-retry]');
    await page.waitForSelector('#whatsapp-retry-send');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await renderer.close();
    await new Promise(resolve => server.close(resolve));
    await application.store.close();
  }
});