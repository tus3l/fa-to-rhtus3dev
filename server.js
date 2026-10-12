import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createSqliteStore, createPostgresStore } from './database/store.js';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import sharp from 'sharp';

const root = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const randomToken = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (max = 200) => z.string().trim().max(max);
const money = z.coerce.number().finite().min(0).max(1e10);
const types = ['invoice', 'payment-proof', 'receipt', 'handover', 'installments', 'financial', 'custom'];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, { message: 'التاريخ غير صالح' });
const optionalDate = z.union([z.literal(''), date]);
const partySchema = z.object({ name: text(), company: text().default(''), phone: text(40).default(''), email: z.union([z.literal(''), z.string().email().max(200)]).default(''), website: text().default(''), taxId: text(80).default(''), notes: text(2000).default('') });
const bankSchema = z.object({ id: text(80).optional(), bank: text().default(''), holder: text().default(''), iban: text(50).default(''), account: text(60).default('') });
const itemSchema = z.object({ id: text(80), name: text(), description: text(2000).default(''), quantity: z.coerce.number().finite().positive().max(1e6), price: money, discount: money }).refine(item => item.discount <= item.quantity * item.price, { message: 'الخصم أكبر من قيمة الخدمة' });
const paymentSchema = z.object({ id: text(80), name: text(), bank: text().default(''), method: z.enum(['bank', 'stc', 'apple', 'cash', 'card', 'other']), date: optionalDate.default(''), amount: money, percentage: z.coerce.number().min(0).max(100), status: z.enum(['paid', 'unpaid', 'partial']), paidAmount: money.default(0), reference: text().default(''), note: text(2000).default('') }).refine(payment => payment.paidAmount <= payment.amount, { message: 'المبلغ المدفوع أكبر من الدفعة' });
const documentSchema = z.object({ type: z.enum(types), title: text(), date, dueDate: optionalDate.default(''), description: text(4000).default(''), notes: text(4000).default(''), provider: partySchema, client: partySchema, items: z.array(itemSchema).max(500), payments: z.array(paymentSchema).max(100), bank: bankSchema.nullable().default(null), declaration: text(12000), currency: z.enum(['SAR', 'USD', 'AED', 'EUR']).default('SAR'), logo: z.string().max(1500000).refine(value => !value || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)).default(''), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#27885c') });
const settingsSchema = z.object({ provider: partySchema, banks: z.array(bankSchema).max(30), logo: documentSchema.shape.logo, accent: documentSchema.shape.accent, declarations: z.record(text(12000)).default({}), numberPrefix: z.string().regex(/^[A-Z0-9-]{1,12}$/).default('TUS') });
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'طلبات كثيرة، حاول بعد قليل' } });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول لاحقًا' } });

export function totals(content) {
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const total = round(content.items.reduce((sum, item) => sum + item.quantity * item.price - item.discount, 0));
  const paid = round(content.payments.reduce((sum, payment) => sum + (payment.status === 'paid' ? payment.amount : payment.status === 'partial' ? payment.paidAmount : 0), 0));
  return { total, paid, remaining: round(total - paid), percentage: total ? round(paid / total * 100) : 0 };
}

export function createApp({ dbPath = resolve(root, 'data/tus3dev.sqlite'), encryptionKey, store: suppliedStore } = {}) {
  const provider = dbPath === ':memory:' ? 'sqlite' : process.env.DATABASE_PROVIDER || (process.env.DATABASE_URL ? 'supabase' : 'sqlite');
  if (!['sqlite', 'supabase'].includes(provider)) throw new Error('DATABASE_PROVIDER must be sqlite or supabase');
  if (process.env.VERCEL === '1') {
    if (provider !== 'supabase' || !process.env.DATABASE_URL) throw new Error('Vercel requires an external PostgreSQL database');
    if (!/^[a-fA-F0-9]{64}$/.test(process.env.LINK_ENCRYPTION_KEY || '')) throw new Error('Vercel requires a stable LINK_ENCRYPTION_KEY');
  }
  const store = suppliedStore || (provider === 'supabase'
    ? createPostgresStore({ connectionString: process.env.DATABASE_URL, ca: process.env.DATABASE_CA_CERT_PATH ? readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') : undefined })
    : createSqliteStore(dbPath));
  const readiness = Promise.resolve().then(() => store.ready());
  readiness.catch(() => {});
  const keyPath = resolve(root, 'data/link.key');
  if (!encryptionKey && process.env.LINK_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(process.env.LINK_ENCRYPTION_KEY)) throw new Error('LINK_ENCRYPTION_KEY must be 64 hexadecimal characters');
  let key = encryptionKey || (process.env.LINK_ENCRYPTION_KEY ? Buffer.from(process.env.LINK_ENCRYPTION_KEY, 'hex') : undefined);
  if (!key && store.dialect === 'postgres' && process.env.NODE_ENV === 'production') throw new Error('Set LINK_ENCRYPTION_KEY before deploying with Supabase');
  if (!key) {
    mkdirSync(dirname(keyPath), { recursive: true });
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    key = readFileSync(keyPath);
  }
  const encrypt = value => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  };
  const decrypt = value => {
    const buffer = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(-16));
    return Buffer.concat([cipher.update(buffer.subarray(12, -16)), cipher.final()]).toString('utf8');
  };
  const config = z.object({ apiBaseUrl: z.string().refine(value => /^\/(?!\/)[^?#]*$/.test(value) || /^https?:\/\//.test(value), { message: 'apiBaseUrl must be an absolute HTTP(S) URL or a local path' }) }).parse(JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8')));
  const remoteApi = config.apiBaseUrl.startsWith('http') ? new URL(config.apiBaseUrl) : null;
  if (remoteApi && (remoteApi.username || remoteApi.password || remoteApi.search || remoteApi.hash)) throw new Error('Do not include credentials, query strings, or fragments in apiBaseUrl');
  if (process.env.NODE_ENV === 'production' && remoteApi?.protocol === 'http:') throw new Error('Use HTTPS for a remote production API');
  const { run, get, all, transaction } = store;
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const event = (id, type, metadata = {}) => run('INSERT INTO document_events(document_id,type,created_at,metadata) VALUES(?,?,?,?)', id, type, now(), JSON.stringify(metadata));
  const ownerDoc = async (req, id) => await get('SELECT * FROM documents WHERE id=? AND user_id=?', id, req.user.id) || fail(404, 'المستند غير موجود');
  const parseDoc = async doc => {
    const content = JSON.parse(doc.content);
    return { ...doc, content, totals: totals(content), signature: await get('SELECT image,signer_name,signed_at,content_hash FROM signatures WHERE document_id=?', doc.id) || null, events: await all('SELECT type,created_at,metadata FROM document_events WHERE document_id=? ORDER BY id', doc.id) };
  };
  const syncRows = async (id, content) => {
    for (const [table, rows] of [['document_items', content.items], ['payments', content.payments]]) {
      await run(`DELETE FROM ${table} WHERE document_id=?`, id);
      for (const [index, row] of rows.entries()) await run(`INSERT INTO ${table}(document_id,position,data) VALUES(?,?,?)`, id, index, JSON.stringify(row));
    }
  };
  const syncClient = async (userId, client) => {
    if (!client.name) return null;
    const existing = client.email ? await get('SELECT id FROM clients WHERE user_id=? AND email=?', userId, client.email) : await get('SELECT id FROM clients WHERE user_id=? AND name=? AND phone=?', userId, client.name, client.phone);
    const id = existing?.id || randomToken();
    await run('INSERT INTO clients(id,user_id,name,email,phone,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,data=excluded.data', id, userId, client.name, client.email, client.phone, JSON.stringify(client));
    return id;
  };
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1' || process.env.VERCEL === '1') app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'", 'data:'], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", ...(remoteApi ? [remoteApi.origin] : [])], objectSrc: ["'none'"], upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null } } }));
  app.get('/config.js', (req, res) => res.set('Cache-Control', 'no-store').type('application/javascript').send(`globalThis.TUS3DEV_CONFIG = Object.freeze(${JSON.stringify(config).replaceAll('<', '\\u003c')});`));
  app.use(express.json({ limit: '3mb' }));
  app.use('/api', apiLimiter);
  app.use('/api', async (req, res, next) => {
    await readiness;
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'مصدر الطلب غير مسموح' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'نوع الطلب غير مسموح' });
    }
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('tus_session='))?.slice(12);
    if (cookie) {
      const session = await get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', hash(cookie), now());
      if (session) { req.session = session; req.user = await get('SELECT id,name,email FROM users WHERE id=?', session.user_id); }
    }
    next();
  });
  const requireOwner = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'انتهت جلسة الحماية، أعد تحميل الصفحة' });
    next();
  };
  const sessionResponse = async (res, user) => {
    await run('DELETE FROM sessions WHERE expires_at<?', now());
    const token = randomToken();
    const csrf = randomToken();
    await run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), user.id, csrf, new Date(Date.now() + 7 * 86400000).toISOString());
    res.cookie('tus_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 7 * 86400000, path: '/' });
    res.json({ user: { id: user.id, name: user.name, email: user.email }, csrf });
  };
  app.get('/api/session', async (req, res) => res.json({ user: req.user || null, csrf: req.session?.csrf || '', setupRequired: !await get('SELECT id FROM users LIMIT 1') }));
  app.post('/api/setup', authLimiter, async (req, res) => {
    if (process.env.VERCEL === '1') fail(403, 'أنشئ حساب المالك من التشغيل المحلي على قاعدة البيانات نفسها قبل النشر العام');
    const input = z.object({ name: text().min(2), email: z.string().email().max(200), password: z.string().min(12).max(128) }).parse(req.body);
    const user = await transaction(async () => {
      if (await get('SELECT id FROM users LIMIT 1')) fail(403, 'تم إعداد حساب المالك مسبقًا');
      const salt = randomBytes(32).toString('hex');
      const user = { id: randomToken(), name: input.name, email: input.email.toLowerCase() };
      await run('INSERT INTO users VALUES(?,?,?,?,?,?)', user.id, user.name, user.email, scryptSync(input.password, salt, 64).toString('hex'), salt, now());
      return user;
    });
    await sessionResponse(res, user);
  });
  app.post('/api/login', authLimiter, async (req, res) => {
    const input = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(128) }).parse(req.body);
    const user = await get('SELECT * FROM users WHERE email=?', input.email.toLowerCase());
    const actual = scryptSync(input.password, user?.salt || 'invalid-login-salt', 64);
    if (!user || !timingSafeEqual(actual, Buffer.from(user.password_hash, 'hex'))) fail(401, 'البريد أو كلمة المرور غير صحيحة');
    await sessionResponse(res, user);
  });
  app.post('/api/logout', requireOwner, async (req, res) => { await run('DELETE FROM sessions WHERE token_hash=?', req.session.token_hash); res.clearCookie('tus_session'); res.json({ ok: true }); });
  app.get('/api/settings', requireOwner, async (req, res) => res.json(JSON.parse((await get('SELECT data FROM settings WHERE user_id=?', req.user.id))?.data || JSON.stringify({ provider: { name: req.user.name, email: req.user.email, company: '', phone: '', website: '', taxId: '', notes: '' }, banks: [], logo: '', accent: '#27885c', declarations: {}, numberPrefix: 'TUS' }))));
  app.put('/api/settings', requireOwner, async (req, res) => {
    const input = settingsSchema.parse(req.body);
    await transaction(async () => {
      await run('INSERT INTO settings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data', req.user.id, JSON.stringify(input));
      await run('UPDATE users SET name=? WHERE id=?', input.provider.name || req.user.name, req.user.id);
      await run('DELETE FROM bank_accounts WHERE user_id=?', req.user.id);
      for (const bank of input.banks) await run('INSERT INTO bank_accounts VALUES(?,?,?)', bank.id || randomToken(), req.user.id, JSON.stringify(bank));
    });
    res.json(input);
  });
  app.get('/api/clients', requireOwner, async (req, res) => res.json((await all('SELECT * FROM clients WHERE user_id=? ORDER BY name', req.user.id)).map(client => ({ ...client, data: JSON.parse(client.data) }))));
  app.get('/api/documents', requireOwner, async (req, res) => res.json(await Promise.all((await all('SELECT * FROM documents WHERE user_id=? ORDER BY updated_at DESC', req.user.id)).map(async doc => {
    const content = JSON.parse(doc.content);
    return { id: doc.id, number: doc.number, revision: doc.revision, status: doc.status, archived: doc.archived, created_at: doc.created_at, updated_at: doc.updated_at, approved_at: doc.approved_at, content, totals: totals(content), events: await all('SELECT type,created_at FROM document_events WHERE document_id=? ORDER BY id', doc.id) };
  }))));
  app.post('/api/documents', requireOwner, async (req, res) => {
    const content = documentSchema.parse(req.body);
    const id = await transaction(async () => {
      const id = randomToken();
      const prefix = JSON.parse((await get('SELECT data FROM settings WHERE user_id=?', req.user.id))?.data || '{}').numberPrefix || 'TUS';
      const sequence = (await get('SELECT COUNT(*) AS count FROM documents WHERE user_id=? AND revision=1', req.user.id)).count + 1;
      const number = `${prefix}-${new Date().getFullYear()}-${String(sequence).padStart(5, '0')}`;
      await run('INSERT INTO documents(id,user_id,client_id,number,type,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, req.user.id, await syncClient(req.user.id, content.client), number, content.type, JSON.stringify(content), now(), now());
      await syncRows(id, content);
      await event(id, 'created');
      return id;
    });
    res.status(201).json(await parseDoc(await ownerDoc(req, id)));
  });
  app.get('/api/documents/:id', requireOwner, async (req, res) => {
    const doc = await parseDoc(await ownerDoc(req, req.params.id));
    const link = await get('SELECT * FROM document_links WHERE document_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', doc.id);
    res.json({ ...doc, link: link ? { token: decrypt(link.encrypted_token), expiresAt: link.expires_at } : null });
  });
  app.put('/api/documents/:id', requireOwner, async (req, res) => {
    const input = z.object({ content: documentSchema, version: z.number().int().positive() }).parse(req.body);
    await transaction(async () => {
      const doc = await ownerDoc(req, req.params.id);
      if (doc.status !== 'Draft') fail(409, 'هذه النسخة مقفلة. أنشئ نسخة معدلة أو ألغِ الرابط قبل التعديل');
      if (doc.version !== input.version) fail(409, 'تم تحديث المستند في نافذة أخرى. أعد فتحه');
      await run('UPDATE documents SET client_id=?,type=?,content=?,version=version+1,updated_at=? WHERE id=?', await syncClient(req.user.id, input.content.client), input.content.type, JSON.stringify(input.content), now(), doc.id);
      await syncRows(doc.id, input.content);
    });
    res.json(await parseDoc(await ownerDoc(req, req.params.id)));
  });
  app.post('/api/documents/:id/link', requireOwner, async (req, res) => {
    const input = z.object({ expiresAt: z.string().datetime().nullable().default(null) }).parse(req.body);
    if (input.expiresAt && input.expiresAt <= now()) fail(400, 'اختر وقت انتهاء في المستقبل');
    const token = await transaction(async () => {
      const doc = await ownerDoc(req, req.params.id);
      if (!['Draft', 'Sent', 'Viewed', 'Awaiting Signature', 'Expired'].includes(doc.status)) fail(409, 'لا يمكن إنشاء رابط لهذه الحالة');
      const content = JSON.parse(doc.content);
      if (!content.client.name || !content.provider.name || !content.title || !content.declaration || !content.items.length || content.items.some(item => !item.name)) fail(400, 'أكمل بيانات الطرفين والخدمات والإقرار أولًا');
      if (totals(content).remaining < 0) fail(400, 'الدفعات المدفوعة تتجاوز قيمة المشروع');
      await run('UPDATE document_links SET revoked_at=? WHERE document_id=? AND revoked_at IS NULL', now(), doc.id);
      const token = randomToken();
      await run('INSERT INTO document_links VALUES(?,?,?,?,?,?,?)', randomToken(), doc.id, hash(token), encrypt(token), input.expiresAt, null, now());
      await run("UPDATE documents SET status='Sent',updated_at=? WHERE id=?", now(), doc.id);
      await event(doc.id, 'link_created', { expiresAt: input.expiresAt });
      return token;
    });
    res.json({ token, expiresAt: input.expiresAt });
  });
  app.delete('/api/documents/:id/link', requireOwner, async (req, res) => {
    await transaction(async () => {
      const doc = await ownerDoc(req, req.params.id);
      if (['Approved', 'Signed', 'Cancelled', 'Rejected'].includes(doc.status)) fail(409, 'لا يمكن تعديل حالة هذه النسخة');
      await run('UPDATE document_links SET revoked_at=? WHERE document_id=? AND revoked_at IS NULL', now(), doc.id);
      await run("UPDATE documents SET status='Draft',updated_at=? WHERE id=?", now(), doc.id);
      await event(doc.id, 'link_revoked');
    });
    res.json({ ok: true });
  });
  app.post('/api/documents/:id/revision', requireOwner, async (req, res) => {
    const id = await transaction(async () => {
      const doc = await ownerDoc(req, req.params.id);
      const id = randomToken();
      const revision = (await get('SELECT MAX(revision) AS revision FROM documents WHERE user_id=? AND number=?', req.user.id, doc.number)).revision + 1;
      await run('INSERT INTO documents(id,user_id,client_id,number,revision,type,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, req.user.id, doc.client_id, doc.number, revision, doc.type, doc.content, now(), now());
      await syncRows(id, JSON.parse(doc.content));
      await event(id, 'created', { previousDocument: doc.id, revision });
      return id;
    });
    res.status(201).json(await parseDoc(await ownerDoc(req, id)));
  });
  app.post('/api/documents/:id/action', requireOwner, async (req, res) => {
    const input = z.object({ action: z.enum(['cancel', 'archive', 'unarchive']) }).parse(req.body);
    await transaction(async () => {
      const doc = await ownerDoc(req, req.params.id);
      if (input.action === 'cancel') {
        if (['Approved', 'Signed'].includes(doc.status)) fail(409, 'لا يمكن إلغاء مستند معتمد؛ احتفظ بسجله وأنشئ نسخة جديدة');
        await run("UPDATE documents SET status='Cancelled',updated_at=? WHERE id=?", now(), doc.id);
        await run('UPDATE document_links SET revoked_at=? WHERE document_id=?', now(), doc.id);
        await event(doc.id, 'cancelled');
      } else {
        await run('UPDATE documents SET archived=?,updated_at=? WHERE id=?', input.action === 'archive' ? 1 : 0, now(), doc.id);
        await event(doc.id, input.action === 'archive' ? 'archived' : 'unarchived');
      }
    });
    res.json({ ok: true });
  });
  const publicDoc = async token => {
    if (!/^[\w-]{43}$/.test(token)) fail(404, 'رابط المستند غير موجود');
    const link = await get('SELECT * FROM document_links WHERE token_hash=?', hash(token));
    if (!link) fail(404, 'رابط المستند غير موجود');
    const doc = await get('SELECT * FROM documents WHERE id=?', link.document_id);
    if (doc.status === 'Cancelled') fail(410, 'هذا المستند ملغي');
    if (link.revoked_at) fail(410, 'تم إلغاء رابط هذا المستند');
    if (link.expires_at && link.expires_at <= now() && doc.status !== 'Approved') {
      if (doc.status !== 'Expired') { await run("UPDATE documents SET status='Expired' WHERE id=?", doc.id); await event(doc.id, 'expired'); }
      fail(410, 'انتهت صلاحية رابط هذا المستند، يرجى التواصل مع مقدم الخدمة');
    }
    return doc;
  };
  const publicPayload = async doc => {
    const parsed = await parseDoc(doc);
    return { number: doc.number, revision: doc.revision, type: doc.type, status: doc.status, content: parsed.content, totals: parsed.totals, signature: parsed.signature, approved_at: doc.approved_at };
  };
  app.get('/api/sign/:token', async (req, res) => {
    let doc = await publicDoc(req.params.token);
    if (doc.status === 'Sent') {
      await transaction(async () => {
        const current = await publicDoc(req.params.token);
        if (current.status === 'Sent') {
          await run("UPDATE documents SET status='Viewed',updated_at=? WHERE id=?", now(), doc.id);
          await event(doc.id, 'viewed', { userAgent: (req.get('user-agent') || '').slice(0, 500) });
        }
      });
      doc = await get('SELECT * FROM documents WHERE id=?', doc.id);
    }
    res.json(await publicPayload(doc));
  });
  app.post('/api/sign/:token', async (req, res) => {
    const input = z.object({ accepted: z.literal(true), signature: z.string().min(200).max(1000000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/), signerName: text().min(1) }).parse(req.body);
    let normalizedImage;
    try {
      const image = Buffer.from(input.signature.split(',')[1], 'base64');
      const decoder = sharp(image, { limitInputPixels: 2048 * 1024 });
      const metadata = await decoder.metadata();
      if (metadata.format !== 'png' || metadata.width < 32 || metadata.height < 32 || metadata.width > 2048 || metadata.height > 1024) fail(400, 'أبعاد التوقيع غير صالحة');
      const { data, info } = await decoder.flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let ink = 0;
      for (let index = 0; index < data.length; index += info.channels) if (data[index] < 200 && data[index + 1] < 200 && data[index + 2] < 200) ink++;
      if (ink < 30) fail(400, 'التوقيع فارغ، ارسم توقيعك أولًا');
      normalizedImage = `data:image/png;base64,${(await sharp(image, { limitInputPixels: 2048 * 1024 }).png().toBuffer()).toString('base64')}`;
    } catch (error) { if (error.status) throw error; fail(400, 'صورة التوقيع غير صالحة'); }
    const doc = await transaction(async () => {
      const doc = await publicDoc(req.params.token);
      if (!['Sent', 'Viewed', 'Awaiting Signature'].includes(doc.status)) fail(409, 'لا يمكن اعتماد هذه النسخة مرة أخرى');
      const content = JSON.parse(doc.content);
      if (input.signerName !== content.client.name) fail(400, 'اسم الموقع لا يطابق العميل');
      const timestamp = now();
      const digest = hash(doc.content);
      await run('INSERT INTO signatures VALUES(?,?,?,?,?,?,?)', randomToken(), doc.id, normalizedImage, input.signerName, timestamp, (req.get('user-agent') || '').slice(0, 500), digest);
      await run('INSERT INTO document_revisions VALUES(?,?,?,?,?,?)', randomToken(), doc.id, doc.revision, doc.content, digest, timestamp);
      await event(doc.id, 'signed', { contentHash: digest, userAgent: (req.get('user-agent') || '').slice(0, 500) });
      await run("UPDATE documents SET status='Approved',approved_at=?,updated_at=? WHERE id=?", timestamp, timestamp, doc.id);
      await event(doc.id, 'approved', { contentHash: digest });
      return await get('SELECT * FROM documents WHERE id=?', doc.id);
    });
    res.json(await publicPayload(doc));
  });
  app.post('/api/sign/:token/reject', async (req, res) => {
    const input = z.object({ reason: text(2000).min(3) }).parse(req.body);
    await transaction(async () => {
      const doc = await publicDoc(req.params.token);
      if (!['Sent', 'Viewed', 'Awaiting Signature'].includes(doc.status)) fail(409, 'لا يمكن رفض هذه النسخة');
      await run("UPDATE documents SET status='Rejected',updated_at=? WHERE id=?", now(), doc.id);
      await event(doc.id, 'rejected', { reason: input.reason });
    });
    res.json({ ok: true });
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/vendor/lucide', express.static(resolve(root, 'node_modules/lucide/dist/umd'), { immutable: true, maxAge: '7d' }));
  app.use('/vendor/signature', express.static(resolve(root, 'node_modules/signature_pad/dist'), { immutable: true, maxAge: '7d' }));
  app.use('/vendor/export', express.static(resolve(root, 'node_modules/html-to-image/dist'), { immutable: true, maxAge: '7d' }));
  app.use('/vendor/fonts/arabic', express.static(resolve(root, 'node_modules/@fontsource/ibm-plex-sans-arabic'), { immutable: true, maxAge: '7d' }));
  app.use('/vendor/fonts/latin', express.static(resolve(root, 'node_modules/@fontsource/manrope'), { immutable: true, maxAge: '7d' }));
  for (const file of ['index.html', 'styles.css', 'app.js']) app.get(file === 'index.html' ? ['/', '/index.html', '/sign/:token'] : `/${file}`, (req, res) => res.sendFile(resolve(root, file)));
  app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'تحقق من البيانات المدخلة', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'حجم البيانات أكبر من المسموح' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'صيغة الطلب غير صالحة' });
    if (!error.status) console.error('Request failed:', error.code || error.name);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'حدث خطأ غير متوقع، حاول مرة أخرى' });
  });
  return { app, db: store.raw, store, ready: readiness };
}

export function createPublicHandler({ environment = process.env, applicationFactory = () => createApp() } = {}) {
  let applicationPromise;
  const handler = express();
  handler.disable('x-powered-by');
  handler.use(async (req, res) => {
    if (!environment.DATABASE_URL || !/^[a-fA-F0-9]{64}$/.test(environment.LINK_ENCRYPTION_KEY || '') || environment.DATABASE_PROVIDER === 'sqlite') {
      return res.status(503).set('Cache-Control', 'no-store').json({ error: 'الخادم العام يحتاج إعداد DATABASE_URL و LINK_ENCRYPTION_KEY من لوحة الاستضافة' });
    }
    try {
      applicationPromise ||= (async () => {
        const application = applicationFactory();
        try { await application.ready; return application; }
        catch (error) { await application.store.close(); throw error; }
      })();
      const { app } = await applicationPromise;
      return app(req, res);
    } catch {
      applicationPromise = null;
      return res.status(503).set('Cache-Control', 'no-store').json({ error: 'تعذر اتصال الخادم بقاعدة البيانات، راجع إعدادات الاستضافة' });
    }
  });
  return handler;
}

export default createPublicHandler();

if (process.env.VERCEL !== '1' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { app, store, ready } = createApp();
    await ready;
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    const server = app.listen(port, host, () => {
      console.log(`TUS3dev ready at http://localhost:${server.address().port}/index.html (${store.dialect})`);
    });
    server.on('error', () => { console.error('Unable to listen on the configured port'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      server.close(async () => { await store.close(); process.exit(0); });
    });
  } catch (error) {
    console.error('Startup failed. Check database configuration, TLS certificate, and SQL schema.', error.code || error.name);
    process.exit(1);
  }
}