import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const approvalCaption = 'تم الاعتماد ✅';

export function whatsappNumber(value) {
  const normalized = String(value || '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).trim();
  const input = normalized.startsWith('00') ? `+${normalized.slice(2)}` : /^966\d{9}$/.test(normalized) ? `+${normalized}` : normalized;
  const phone = parsePhoneNumberFromString(input, 'SA');
  if (!phone?.isValid()) throw new Error('رقم العميل غير صالح؛ استخدم رقم الجوال مع رمز الدولة مثل +9665XXXXXXXX');
  return phone.number.slice(1);
}

export function createWhatsappService({ directory, renderImage, clientFactory, qrImage } = {}) {
  const jobs = new Map();
  let client;
  let initializing;
  let running;
  let timer;
  let generation = 0;
  let state = { status: 'disconnected', qr: null, phone: '', error: '' };
  const ready = (async () => {
    await mkdir(resolve(directory, 'outbox'), { recursive: true, mode: 0o700 });
    for (const file of await readdir(resolve(directory, 'outbox'))) {
      if (!file.endsWith('.json')) continue;
      const job = JSON.parse(await readFile(resolve(directory, 'outbox', file), 'utf8'));
      if (job.status === 'sending') { job.status = 'uncertain'; job.error = 'انقطع الخادم أثناء الإرسال؛ تحقق من المحادثة قبل إعادة المحاولة'; }
      jobs.set(job.id, job);
    }
  })();
  const persist = async job => {
    const path = resolve(directory, 'outbox', `${job.id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  const snapshot = () => ({ ...state, jobs: [...jobs.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt)).slice(0, 50).map(({ document, ...job }) => job) });
  async function flush() {
    await ready;
    if (running || state.status !== 'connected') return running;
    running = (async () => {
      for (const job of jobs.values()) {
        if (state.status !== 'connected') break;
        if (job.status !== 'pending') continue;
        let image;
        let recipient;
        try {
          recipient = await client.getNumberId(job.phone);
          if (!recipient) throw new Error('رقم العميل غير مسجل في واتساب');
          image = await renderImage(job.document);
        } catch (error) {
          job.status = 'failed'; job.error = error.message || 'تعذر تجهيز الفاتورة';
          await persist(job);
          continue;
        }
        job.status = 'sending'; job.error = '';
        await persist(job);
        try {
          const result = await client.sendImage(recipient._serialized, image, `${job.number}.png`, approvalCaption);
          job.status = 'sent'; job.sentAt = new Date().toISOString(); job.messageId = result?.id?._serialized || '';
        } catch {
          job.status = 'uncertain'; job.error = 'تعذر تأكيد الإرسال؛ تحقق من محادثة العميل قبل إعادة المحاولة';
        }
        await persist(job);
      }
    })();
    try { await running; } finally { running = null; }
  }
  async function connect() {
    await ready;
    if (initializing || ['connected', 'connecting', 'qr'].includes(state.status)) return snapshot();
    state = { status: 'connecting', qr: null, phone: '', error: '' };
    await writeFile(resolve(directory, 'enabled'), '1', { mode: 0o600 });
    const current = ++generation;
    initializing = (async () => {
      try {
        await client?.destroy().catch(() => {});
        if (clientFactory) client = await clientFactory();
        else {
          const { default: library } = await import('whatsapp-web.js');
          const { Client, LocalAuth, MessageMedia } = library;
          client = new Client({ authStrategy: new LocalAuth({ dataPath: resolve(directory, 'session') }), authTimeoutMs: 60000, webVersionCache: { type: 'local', path: resolve(directory, 'cache') }, puppeteer: { headless: true } });
          client.sendImage = (recipient, image, filename, caption) => client.sendMessage(recipient, new MessageMedia('image/png', image.toString('base64'), filename), { caption, sendSeen: false });
        }
        client.on('qr', async value => {
          try {
            const image = qrImage ? await qrImage(value) : await (await import('qrcode')).default.toDataURL(value, { width: 280, margin: 2 });
            if (current === generation && ['connecting', 'qr'].includes(state.status)) state = { status: 'qr', qr: image, phone: '', error: '' };
          } catch { if (current === generation) state = { status: 'error', qr: null, phone: '', error: 'تعذر إنشاء رمز QR' }; }
        });
        client.on('ready', () => {
          if (current !== generation) return;
          state = { status: 'connected', qr: null, phone: client.info?.wid?.user || '', error: '' };
          void flush().catch(() => { state.error = 'تعذر تحديث طابور الإرسال'; });
        });
        for (const name of ['auth_failure', 'disconnected']) client.on(name, () => {
          if (current === generation) state = { status: 'disconnected', qr: null, phone: '', error: 'انقطع اتصال واتساب، أعد الربط' };
        });
        await client.initialize();
      } catch { if (current === generation) state = { status: 'error', qr: null, phone: '', error: 'تعذر تشغيل واتساب؛ تحقق من اتصال الإنترنت وتثبيت Chrome' }; }
      finally { initializing = null; }
    })();
    return snapshot();
  }
  return {
    async status() { await ready; return snapshot(); },
    connect,
    async resume() {
      await ready;
      try { await readFile(resolve(directory, 'enabled')); await connect(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      timer = setInterval(() => { void flush().catch(() => { state.error = 'تعذر تحديث طابور الإرسال'; }); }, 15000);
      timer.unref();
    },
    async enqueue(id, document) {
      await ready;
      if (!/^[\w-]{1,100}$/.test(id)) throw new Error('معرف المستند غير صالح');
      if (document.status !== 'Approved' || !document.signature) throw new Error('لا يمكن إرسال مستند غير معتمد');
      if (jobs.has(id)) return;
      const job = { id, number: document.number, clientName: document.content.client.name, phone: '', document, status: 'pending', createdAt: new Date().toISOString(), error: '' };
      try { job.phone = whatsappNumber(document.content.client.phone); }
      catch (error) { job.status = 'failed'; job.error = error.message; }
      await persist(job);
      jobs.set(id, job);
      void flush().catch(() => { state.error = 'تعذر تحديث طابور الإرسال'; });
    },
    async retry(id, phone) {
      await ready;
      const job = jobs.get(id);
      if (!job || !['failed', 'uncertain'].includes(job.status)) throw new Error('هذه الرسالة لا تحتاج إعادة إرسال');
      job.phone = whatsappNumber(phone || job.phone);
      job.status = 'pending'; job.error = '';
      await persist(job);
      void flush().catch(() => { state.error = 'تعذر تحديث طابور الإرسال'; });
    },
    async disconnect() {
      await ready;
      generation++;
      state = { status: 'disconnected', qr: null, phone: '', error: '' };
      await initializing;
      await running;
      if (client) { await client.logout().catch(() => {}); await client.destroy().catch(() => {}); client = null; }
      await rm(resolve(directory, 'session'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(resolve(directory, 'enabled'), { force: true });
      return snapshot();
    },
    flush,
    async close() { clearInterval(timer); generation++; await initializing; await running; await client?.destroy(); }
  };
}