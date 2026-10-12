import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp, totals } from '../server.js';
import sharp from 'sharp';

let server;
let db;
let base;
let cookie = '';
let csrf = '';
const party = { name: 'Test owner', company: '', phone: '', email: '', website: '', taxId: '', notes: '' };
const content = () => ({ type: 'invoice', title: 'Test invoice', date: '2026-10-11', dueDate: '', provider: { ...party }, client: { ...party, name: 'Test client' }, description: '', notes: '', items: [{ id: 'item-1', name: 'Development', description: '', quantity: 2, price: 100, discount: 10 }], payments: [{ id: 'payment-1', name: 'First payment', bank: '', method: 'bank', date: '', amount: 95, percentage: 50, status: 'paid', paidAmount: 0, reference: '', note: '' }], bank: null, declaration: 'I reviewed and accept this document.', currency: 'SAR', logo: '', accent: '#28765a' });
async function request(path, method = 'GET', body, options = {}) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(options.public ? {} : { Cookie: cookie, 'X-CSRF-Token': csrf }), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
before(async () => {
  const application = createApp({ dbPath: ':memory:', encryptionKey: randomBytes(32) });
  db = application.db;
  server = application.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

test('Render accepts its HTTPS origin behind an internal proxy and rejects other origins', async () => {
  const keys = ['RENDER', 'RENDER_EXTERNAL_URL', 'TRUST_PROXY', 'NODE_ENV', 'VERCEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let application;
  let renderServer;
  try {
    Object.assign(process.env, { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://tus3dev-test.onrender.com', NODE_ENV: 'production' });
    delete process.env.TRUST_PROXY;
    delete process.env.VERCEL;
    application = createApp({ dbPath: ':memory:', encryptionKey: randomBytes(32) });
    await application.ready;
    assert.equal(application.app.get('trust proxy'), 1);
    renderServer = application.app.listen(0, '127.0.0.1');
    await new Promise(resolve => renderServer.once('listening', resolve));
    const endpoint = `http://127.0.0.1:${renderServer.address().port}/api/setup`;
    const headers = { 'Content-Type': 'application/json', Host: 'internal-service:10000', 'X-Forwarded-Proto': 'https' };
    for (const origin of ['https://other-site.example', 'http://tus3dev-test.onrender.com', 'https://tus3dev-test.onrender.com.other-site.example', 'null']) {
      const rejected = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: origin }, body: '{}' });
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).error, 'مصدر الطلب غير مسموح');
    }
    const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: process.env.RENDER_EXTERNAL_URL }, body: JSON.stringify({ name: 'Render test owner', email: 'render-test@example.com', password: 'test-only-render-password-2026' }) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('set-cookie').includes('Secure'));
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(response.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.equal((await response.json()).user.email, 'render-test@example.com');
  } finally {
    if (renderServer) await new Promise(resolve => renderServer.close(resolve));
    await application?.store.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('owner bootstrap, login, and protected CSRF session', async () => {
  const config = await fetch(`${base}/config.js`);
  assert.equal(config.status, 200);
  assert.ok((await config.text()).includes('"apiBaseUrl":"/api"'));
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/documents', 'GET', undefined, { public: true })).response.status, 401);
  assert.equal((await request('/whatsapp', 'GET', undefined, { public: true })).response.status, 404);
  const setup = await request('/setup', 'POST', { name: 'Test owner', email: 'test@example.com', password: 'test-only-password-2026' });
  assert.equal(setup.response.status, 200);
  cookie = setup.response.headers.get('set-cookie').split(';')[0];
  csrf = setup.data.csrf;
  assert.ok(setup.response.headers.get('set-cookie').includes('HttpOnly'));
  assert.ok(setup.response.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.equal((await request('/setup', 'POST', { name: 'Other', email: 'other@example.com', password: 'test-only-password-2026' })).response.status, 403);
  assert.equal((await request('/documents', 'POST', content(), { headers: { 'X-CSRF-Token': '' } })).response.status, 403);
  assert.equal((await request('/whatsapp/connect', 'POST', {})).response.status, 404);
  assert.equal((await request('/documents', 'POST', content(), { headers: { Origin: 'https://evil.example' } })).response.status, 403);
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  assert.notEqual(user.password_hash, 'test-only-password-2026');
  assert.equal(user.password_hash.length, 128);
});

test('financial totals include discount and partially paid installments', () => {
  const doc = content();
  assert.deepEqual(totals(doc), { total: 190, paid: 95, remaining: 95, percentage: 50 });
  doc.payments[0].status = 'partial';
  doc.payments[0].paidAmount = 40;
  assert.equal(totals(doc).paid, 40);
  assert.equal(totals(doc).remaining, 150);
});

test('draft autosave uses optimistic versions and validates inputs', async () => {
  const created = await request('/documents', 'POST', content());
  assert.equal(created.response.status, 201);
  assert.match(created.data.number, /^TUS-\d{4}-\d{5}$/);
  const changed = content(); changed.title = 'Updated title';
  const update = await request(`/documents/${created.data.id}`, 'PUT', { content: changed, version: 1 });
  assert.equal(update.response.status, 200);
  assert.equal(update.data.version, 2);
  assert.equal(update.data.content.title, 'Updated title');
  assert.equal((await request(`/documents/${created.data.id}`, 'PUT', { content: changed, version: 1 })).response.status, 409);
  const invalid = content(); invalid.items[0].discount = 1000;
  assert.equal((await request('/documents', 'POST', invalid)).response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM document_items WHERE document_id=?').get(created.data.id).count, 1);
  const partialBank = content(); partialBank.bank = { bank: 'Bank in progress' };
  assert.equal((await request('/documents', 'POST', partialBank)).response.status, 201);
  assert.equal((await request(`/documents/${created.data.id}`, 'GET', undefined, { public: true })).response.status, 401);
});

test('link tokens are unpredictable, private, revocable, and lock sent content', async () => {
  const created = (await request('/documents', 'POST', content())).data;
  const link = await request(`/documents/${created.id}/link`, 'POST', { expiresAt: null });
  assert.equal(link.response.status, 200);
  assert.equal(link.data.token.length, 43);
  const stored = db.prepare('SELECT * FROM document_links WHERE document_id=?').get(created.id);
  assert.notEqual(stored.encrypted_token, link.data.token);
  assert.notEqual(stored.token_hash, link.data.token);
  const publicDoc = await request(`/sign/${link.data.token}`, 'GET', undefined, { public: true });
  assert.equal(publicDoc.data.status, 'Viewed');
  assert.equal(publicDoc.data.id, undefined);
  assert.equal(publicDoc.data.user_id, undefined);
  assert.equal((await request(`/documents/${created.id}`, 'PUT', { content: content(), version: 1 })).response.status, 409);
  assert.equal((await request(`/documents/${created.id}/link`, 'DELETE', {})).response.status, 200);
  assert.equal((await request(`/sign/${link.data.token}`, 'GET', undefined, { public: true })).response.status, 410);
  assert.equal((await request(`/documents/${created.id}`)).data.status, 'Draft');
  assert.equal((await request('/sign/invalid-token', 'GET', undefined, { public: true })).response.status, 404);
});

test('approval records snapshot, audit, signature, and creates independent revisions', async () => {
  const created = (await request('/documents', 'POST', content())).data;
  const link = (await request(`/documents/${created.id}/link`, 'POST', { expiresAt: null })).data;
  assert.equal((await request(`/sign/${link.token}`, 'POST', { accepted: true, signature: '', signerName: 'Test client' }, { public: true })).response.status, 400);
  const blank = await sharp({ create: { width: 300, height: 150, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await request(`/sign/${link.token}`, 'POST', { accepted: true, signature: `data:image/png;base64,${blank.toString('base64')}`, signerName: 'Test client' }, { public: true })).response.status, 400);
  const image = await sharp(blank).composite([{ input: Buffer.alloc(120 * 8 * 3, 30), raw: { width: 120, height: 8, channels: 3 }, left: 30, top: 60 }]).png().toBuffer();
  const signature = `data:image/png;base64,${image.toString('base64')}`;
  assert.equal((await request(`/sign/${link.token}`, 'POST', { accepted: false, signature, signerName: 'Test client' }, { public: true })).response.status, 400);
  const signed = await request(`/sign/${link.token}`, 'POST', { accepted: true, signature, signerName: 'Test client' }, { public: true });
  assert.equal(signed.response.status, 200);
  assert.equal(signed.data.status, 'Approved');
  assert.ok(signed.data.approved_at);
  assert.equal(signed.data.signature.content_hash.length, 64);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM document_revisions WHERE document_id=?').get(created.id).count, 1);
  const owner = (await request(`/documents/${created.id}`)).data;
  assert.ok(owner.events.some(event => event.type === 'signed'));
  assert.ok(owner.events.some(event => event.type === 'approved'));
  assert.equal((await request(`/documents/${created.id}`, 'PUT', { content: content(), version: 1 })).response.status, 409);
  assert.equal((await request(`/documents/${created.id}/action`, 'POST', { action: 'cancel' })).response.status, 409);
  assert.equal((await request(`/sign/${link.token}`, 'POST', { accepted: true, signature, signerName: 'Test client' }, { public: true })).response.status, 409);
  const revision = await request(`/documents/${created.id}/revision`, 'POST', {});
  assert.equal(revision.response.status, 201);
  assert.equal(revision.data.number, created.number);
  assert.equal(revision.data.revision, 2);
  assert.equal(revision.data.status, 'Draft');
  assert.equal(revision.data.signature, null);
  assert.equal(revision.data.link, undefined);
  assert.equal((await request(`/documents/${created.id}`)).data.status, 'Approved');
  assert.throws(() => db.prepare('UPDATE documents SET content=? WHERE id=?').run('{}', created.id), /immutable/);
  assert.throws(() => db.prepare('UPDATE signatures SET signer_name=? WHERE document_id=?').run('Changed signer', created.id), /immutable/);
  assert.throws(() => db.prepare('UPDATE document_revisions SET content=? WHERE document_id=?').run('{}', created.id), /immutable/);
});

test('expired, cancelled, rejected, and regenerated links cannot approve', async () => {
  const created = (await request('/documents', 'POST', content())).data;
  assert.equal((await request(`/documents/${created.id}/link`, 'POST', { expiresAt: '2020-01-01T00:00:00.000Z' })).response.status, 400);
  const first = (await request(`/documents/${created.id}/link`, 'POST', { expiresAt: null })).data;
  const second = (await request(`/documents/${created.id}/link`, 'POST', { expiresAt: null })).data;
  assert.notEqual(first.token, second.token);
  assert.equal((await request(`/sign/${first.token}`, 'GET', undefined, { public: true })).response.status, 410);
  db.prepare('UPDATE document_links SET expires_at=? WHERE token_hash IS NOT NULL AND document_id=? AND revoked_at IS NULL').run('2020-01-01T00:00:00.000Z', created.id);
  assert.equal((await request(`/sign/${second.token}`, 'GET', undefined, { public: true })).response.status, 410);
  assert.equal((await request(`/documents/${created.id}`)).data.status, 'Expired');
  const third = (await request(`/documents/${created.id}/link`, 'POST', { expiresAt: null })).data;
  await request(`/documents/${created.id}/action`, 'POST', { action: 'cancel' });
  assert.equal((await request(`/sign/${third.token}`, 'GET', undefined, { public: true })).response.status, 410);
  const another = (await request('/documents', 'POST', content())).data;
  const rejectedLink = (await request(`/documents/${another.id}/link`, 'POST', { expiresAt: null })).data;
  assert.equal((await request(`/sign/${rejectedLink.token}/reject`, 'POST', { reason: 'Please change scope' }, { public: true })).response.status, 200);
  assert.equal((await request(`/documents/${another.id}`)).data.status, 'Rejected');
});

test('settings, clients, and archive use persistent normalized records', async () => {
  const settings = { provider: party, banks: [{ id: 'test-bank', bank: 'Bank', holder: 'Owner', iban: 'SA000000', account: '' }], logo: '', accent: '#28765a', declarations: {}, numberPrefix: 'DEV' };
  assert.equal((await request('/settings', 'PUT', settings)).response.status, 200);
  assert.equal((await request('/settings')).data.banks.length, 1);
  assert.ok((await request('/clients')).data.length);
  const created = (await request('/documents', 'POST', content())).data;
  assert.ok(created.number.startsWith('DEV-'));
  await request(`/documents/${created.id}/action`, 'POST', { action: 'archive' });
  assert.equal((await request(`/documents/${created.id}`)).data.archived, 1);
  await request(`/documents/${created.id}/action`, 'POST', { action: 'unarchive' });
  assert.equal((await request(`/documents/${created.id}`)).data.archived, 0);
  const html = await fetch(`${base}/index.html`);
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes('dir="rtl"'));
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/data/tus3dev.sqlite`)).status, 404);
});