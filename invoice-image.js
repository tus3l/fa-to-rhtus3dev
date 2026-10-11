import puppeteer from 'puppeteer';

export function createInvoiceRenderer({ origin }) {
  let browser;
  return {
    async render(document) {
      if (!browser?.connected) browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 850, height: 1200, deviceScaleFactor: 2 });
        await page.evaluateOnNewDocument(() => { globalThis.TUS3DEV_IMAGE_RENDER = true; });
        await page.goto(`${origin()}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.waitForFunction(() => typeof paper === 'function');
        await page.evaluate(async payload => {
          document.body.className = '';
          document.body.style.cssText = 'background:white;margin:0;width:794px;';
          document.body.innerHTML = paper(payload);
          document.querySelector('.document-paper').classList.add('export-paper');
          refreshIcons();
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
        }, document);
        const node = await page.$('.document-paper');
        const bounds = await node.boundingBox();
        if (bounds.height > 30000) throw new Error('الفاتورة طويلة جدًا لإرسالها كصورة واحدة');
        return Buffer.from(await node.screenshot({ type: 'png' }));
      } finally { await page.close(); }
    },
    async close() { await browser?.close(); }
  };
}