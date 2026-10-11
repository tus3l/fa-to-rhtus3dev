import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createSqliteStore, createPostgresStore } from '../database/store.js';
import { createApp } from '../server.js';
import { randomBytes, createHash } from 'node:crypto';
import sharp from 'sharp';

async function embeddedPostgresStore() {
  const db = new PGlite();
  await db.exec(readFileSync(new URL('../database/schema.postgres.sql', import.meta.url), 'utf8'));
  let queue = Promise.resolve();
  const pool = {
    connect: async () => {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      return { query: (sql, params) => db.query(sql, params), release };
    },
    end: () => db.close()
  };
  return createPostgresStore({ pool });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect} store normalizes rows, rolls back, and serializes concurrent writes`, async () => {
    const store = dialect === 'sqlite' ? createSqliteStore(':memory:') : await embeddedPostgresStore();
    try {
      await store.ready();
      await store.run('INSERT INTO users VALUES(?,?,?,?,?,?)', 'owner', 'Owner', 'owner@example.com', 'hash', 'salt', '2026-10-11T00:00:00.000Z');
      await store.run('INSERT INTO documents(id,user_id,number,type,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', 'doc', 'owner', 'TUS-1', 'invoice', '{}', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
      const row = await store.get('SELECT * FROM documents WHERE id=?', 'doc');
      assert.equal(row.content, '{}');
      assert.equal(row.archived, 0);
      assert.equal(row.created_at, '2026-10-11T00:00:00.000Z');
      await assert.rejects(store.transaction(async () => {
        await store.run('UPDATE documents SET version=5 WHERE id=?', 'doc');
        throw new Error('Rollback probe');
      }), /Rollback probe/);
      assert.equal((await store.get('SELECT version FROM documents WHERE id=?', 'doc')).version, 1);
      await Promise.all(Array.from({ length: 3 }, () => store.transaction(async () => {
        const row = await store.get('SELECT version FROM documents WHERE id=?', 'doc');
        await store.run('UPDATE documents SET version=? WHERE id=?', row.version + 1, 'doc');
      })));
      assert.equal((await store.get('SELECT version FROM documents WHERE id=?', 'doc')).version, 4);
      assert.equal((await store.get('SELECT COUNT(*) AS count FROM documents')).count, 1);
    } finally { await store.close(); }
  });
}

test('Supabase PostgreSQL API preserves sessions, drafts, approval, revisions, and concurrent signing', async () => {
  const store = await embeddedPostgresStore();
  const { app, ready } = createApp({ store, encryptionKey: randomBytes(32) });
  await ready;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  let csrf = '';
  const request = async (path, method = 'GET', body, publicRequest = false) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(!publicRequest ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  try {
    const setup = await request('/setup', 'POST', { name: 'PG owner', email: 'pg-test@example.com', password: 'isolated-postgres-test-2026' });
    assert.equal(setup.response.status, 200);
    cookie = setup.response.headers.get('set-cookie').split(';')[0]; csrf = setup.data.csrf;
    const provider = { name: 'PG owner', company: '', email: '', phone: '', website: '', taxId: '', notes: '' };
    const settings = { provider, banks: [{ id: 'bank', bank: 'Test bank', holder: 'PG owner', iban: 'SA0000', account: '' }], logo: '', accent: '#28765a', declarations: {}, numberPrefix: 'PG' };
    assert.equal((await request('/settings', 'PUT', settings)).response.status, 200);
    assert.equal((await request('/settings')).data.banks[0].bank, 'Test bank');
    const content = { type: 'invoice', title: 'PG invoice', date: '2026-10-11', dueDate: '', provider, client: { ...provider, name: 'PG client' }, description: '', notes: '', items: [{ id: 'item', name: 'Development', description: '', quantity: 1, price: 1000, discount: 0 }], payments: [{ id: 'payment', name: 'First', bank: '', method: 'bank', date: '', amount: 500, percentage: 50, status: 'paid', paidAmount: 0, reference: '', note: '' }], bank: null, declaration: 'I accept this document.', currency: 'SAR', logo: '', accent: '#28765a' };
    const created = await request('/documents', 'POST', content);
    assert.equal(created.response.status, 201);
    const id = created.data.id;
    assert.match(created.data.number, /^PG-\d{4}-\d{5}$/);
    assert.equal(created.data.totals.remaining, 500);
    const saved = await request(`/documents/${id}`, 'PUT', { content: { ...content, notes: 'Saved on PostgreSQL' }, version: 1 });
    assert.equal(saved.data.version, 2);
    assert.equal((await request(`/documents/${id}`, 'PUT', { content, version: 1 })).response.status, 409);
    assert.equal((await request('/clients')).data[0].name, 'PG client');
    assert.equal((await request('/documents')).data[0].content.notes, 'Saved on PostgreSQL');
    const link = (await request(`/documents/${id}/link`, 'POST', { expiresAt: null })).data;
    assert.equal((await request(`/sign/${link.token}`, 'GET', undefined, true)).data.status, 'Viewed');
    const png = await sharp({ create: { width: 350, height: 150, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.alloc(120 * 8 * 3, 30), raw: { width: 120, height: 8, channels: 3 }, left: 30, top: 60 }]).png().toBuffer();
    const approval = { accepted: true, signerName: 'PG client', signature: `data:image/png;base64,${png.toString('base64')}` };
    const responses = await Promise.all([request(`/sign/${link.token}`, 'POST', approval, true), request(`/sign/${link.token}`, 'POST', approval, true)]);
    assert.deepEqual(responses.map(result => result.response.status).sort(), [200, 409]);
    const approved = (await request(`/documents/${id}`)).data;
    assert.equal(approved.status, 'Approved');
    assert.ok(approved.approved_at);
    assert.ok(approved.events.some(event => event.type === 'approved'));
    const stored = await store.get('SELECT content FROM documents WHERE id=?', id);
    assert.equal(approved.signature.content_hash, createHash('sha256').update(stored.content).digest('hex'));
    assert.equal((await request(`/documents/${id}`, 'PUT', { content, version: 2 })).response.status, 409);
    assert.equal((await request(`/documents/${id}/action`, 'POST', { action: 'archive' })).response.status, 200);
    assert.equal((await request(`/documents/${id}`)).data.archived, 1);
    const revision = await request(`/documents/${id}/revision`, 'POST', {});
    assert.equal(revision.data.revision, 2);
    assert.equal(revision.data.signature, null);
    const newLink = (await request(`/documents/${revision.data.id}/link`, 'POST', { expiresAt: null })).data;
    assert.equal((await request(`/sign/${newLink.token}/reject`, 'POST', { reason: 'Please revise scope' }, true)).response.status, 200);
    assert.equal((await request(`/documents/${revision.data.id}`)).data.status, 'Rejected');
    const concurrent = await Promise.all([request('/documents', 'POST', content), request('/documents', 'POST', content)]);
    assert.ok(concurrent.every(result => result.response.status === 201));
    assert.notEqual(concurrent[0].data.number, concurrent[1].data.number);
    assert.equal((await request('/logout', 'POST', {})).response.status, 200);
    assert.equal((await request('/documents')).response.status, 401);
    const login = await request('/login', 'POST', { email: 'pg-test@example.com', password: 'isolated-postgres-test-2026' });
    assert.equal(login.response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.close();
  }
});