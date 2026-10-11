const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = name => `<i data-lucide="${name === 'cloud-check' ? 'cloud' : name}"></i>`;
const uid = () => crypto.randomUUID();
const apiBaseUrl = (globalThis.TUS3DEV_CONFIG?.apiBaseUrl || '/api').replace(/\/+$/, '');
const isoDate = () => new Date().toISOString().slice(0, 10);
const typeInfo = {
  invoice: ['فاتورة مشروع', 'receipt-text'],
  'payment-proof': ['إثبات دفع', 'badge-check'],
  receipt: ['إقرار استلام مشروع', 'folder-check'],
  handover: ['إقرار تسليم مشروع', 'package-check'],
  installments: ['اتفاق دفعات', 'wallet-cards'],
  financial: ['إقرار مالي', 'landmark'],
  custom: ['مستند مخصص', 'file-pen-line']
};
const statusLabels = { Draft: 'مسودة', Sent: 'بانتظار التوقيع', Viewed: 'تمت المشاهدة', 'Awaiting Signature': 'بانتظار التوقيع', Signed: 'تم التوقيع', Approved: 'تم الاعتماد', Rejected: 'مرفوض', Cancelled: 'ملغي', Expired: 'منتهي الصلاحية' };
const eventLabels = { created: 'تم إنشاء المستند', link_created: 'تم إنشاء رابط العميل', viewed: 'فتح العميل المستند', signed: 'وقّع العميل المستند', approved: 'تم اعتماد المستند', rejected: 'رفض العميل المستند', cancelled: 'تم إلغاء المستند', expired: 'انتهت صلاحية الرابط', link_revoked: 'تم إلغاء رابط العميل', archived: 'تمت أرشفة المستند', unarchived: 'تمت استعادة المستند' };
const methodLabels = { bank: 'تحويل بنكي', stc: 'STC Pay', apple: 'Apple Pay', cash: 'نقدي', card: 'بطاقة', other: 'أخرى' };
const paymentLabels = { paid: 'مدفوعة', unpaid: 'غير مدفوعة', partial: 'مدفوعة جزئيًا' };
const pendingStatuses = ['Sent', 'Viewed', 'Awaiting Signature'];
const defaultDeclaration = type => type === 'receipt' || type === 'handover'
  ? 'أقر أنا العميل المذكور اسمي أعلاه بأنني استلمت المشروع والخدمات الموضحة في هذا المستند، وقمت بمراجعتها، وأؤكد استلامها وفق الاتفاق الموضح بين الطرفين.'
  : 'أقر أنا العميل المذكور اسمي أعلاه بأنني قمت بمراجعة جميع المعلومات والتفاصيل المالية والخدمات الموضحة في هذا المستند، وأن المعلومات الواردة صحيحة حسب الاتفاق بين الطرفين، وأوافق عليها وأعتمدها إلكترونيًا.';
const emptyParty = () => ({ name: '', company: '', phone: '', email: '', website: '', taxId: '', notes: '' });
const emptySettings = () => ({ provider: emptyParty(), banks: [], logo: '', accent: '#28765a', declarations: {}, numberPrefix: 'TUS' });
const state = { user: null, csrf: '', setupRequired: false, settings: emptySettings(), documents: [], clients: [], current: null, filters: { tab: 'all', search: '', type: '', status: '', payment: '', from: '', to: '' }, page: 1, summaryCurrency: 'SAR', view: '', saving: Promise.resolve(), saveTimer: null, dirty: false, inFlight: false, signed: false, signatureConfirmed: false, pad: null, redo: [], poll: null, routeSequence: 0 };
let modalResolver = null;
let modalPreviousFocus = null;
let signatureObserver = null;
let whatsappPoll = null;

function refreshIcons(parent = document) {
  if (globalThis.lucide) lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
}
function formatMoney(value, currency = 'SAR', withCurrency = true) {
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
  return withCurrency ? `${formatted} ${currency}` : formatted;
}
function dateLabel(value, includeTime = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', year: 'numeric', month: 'short', day: 'numeric', ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value));
}
function calculate(content) {
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const total = round(content.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price) - Number(item.discount), 0));
  const paid = round(content.payments.reduce((sum, payment) => sum + (payment.status === 'paid' ? Number(payment.amount) : payment.status === 'partial' ? Number(payment.paidAmount) : 0), 0));
  return { total, paid, remaining: round(total - paid), percentage: total ? round(paid / total * 100) : 0 };
}
function badge(status) { return `<span class="badge ${escapeHtml(status.split(' ')[0])}">${escapeHtml(statusLabels[status] || status)}</span>`; }
function toast(message, error = false) {
  $('#toast-root').innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'circle-alert' : 'circle-check')}<span>${escapeHtml(message)}</span></div>`;
  refreshIcons();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, 4200);
}
async function api(path, options = {}) {
  let response;
  try { response = await fetch(`${apiBaseUrl}${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
  catch { throw new Error('تعذر الاتصال بالخادم. تحقق من الاتصال وحاول مرة أخرى'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'تعذر إكمال الطلب');
    error.status = response.status;
    error.details = data.details;
    throw error;
  }
  return data;
}
function modal(title, content, actions = '', wide = false) {
  closeModal();
  modalPreviousFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="icon-button" data-close-modal title="إغلاق" aria-label="إغلاق">${icon('x')}</button></div>${content}${actions ? `<div class="modal-actions">${actions}</div>` : ''}</section></div>`;
  document.body.style.overflow = 'hidden';
  refreshIcons();
  $('.modal input, .modal select, .modal textarea, .modal button')?.focus();
}
function closeModal(result = false) {
  if (!$('#modal-root').children.length) return;
  $('#modal-root').innerHTML = '';
  document.body.style.overflow = '';
  const resolve = modalResolver;
  modalResolver = null;
  resolve?.(result);
  if (modalPreviousFocus?.isConnected) modalPreviousFocus.focus();
}
function confirmDialog(title, message, buttonText = 'تأكيد', danger = false) {
  modal(title, `<p>${escapeHtml(message)}</p>`, `<button class="btn" data-close-modal>رجوع</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-modal">${escapeHtml(buttonText)}</button>`);
  return new Promise(resolve => { modalResolver = resolve; $('#confirm-modal').onclick = () => closeModal(true); });
}
$('#modal-root').addEventListener('click', event => {
  if (event.target.closest('[data-close-modal]') || event.target.classList.contains('modal-backdrop')) closeModal();
});
document.addEventListener('keydown', event => {
  if (!$('#modal-root').children.length) return;
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab') {
    const focusables = $$('.modal button:not(:disabled),.modal input,.modal select,.modal textarea,.modal a[href]');
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

async function authenticate() {
  if (state.user) return true;
  const setup = state.setupRequired;
  modal(setup ? 'إنشاء حساب المالك' : 'مرحبًا بعودتك', `<form id="auth-form"><div class="fields">${setup ? field('auth-name', 'الاسم', '', 'text', { required: true, autocomplete: 'name' }) : ''}${field('auth-email', 'البريد الإلكتروني', '', 'email', { required: true, autocomplete: 'username' })}${field('auth-password', 'كلمة المرور', '', 'password', { required: true, minlength: setup ? 12 : 1, maxlength: 128, autocomplete: setup ? 'new-password' : 'current-password', hint: setup ? '12 حرفًا على الأقل' : '' })}</div><p class="modal-error" id="auth-error" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-close-modal>رجوع</button><button class="btn btn-primary" type="submit">${setup ? 'إنشاء الحساب' : 'تسجيل الدخول'}${icon('arrow-left')}</button></div></form>`);
  return new Promise(resolve => {
    modalResolver = resolve;
    $('#auth-form').onsubmit = async event => {
      event.preventDefault();
      const button = $('button[type=submit]', event.target);
      button.disabled = true;
      try {
        const data = await api(setup ? '/setup' : '/login', { method: 'POST', body: { ...(setup ? { name: $('[name=auth-name]').value } : {}), email: $('[name=auth-email]').value, password: $('[name=auth-password]').value } });
        state.user = data.user; state.csrf = data.csrf; state.setupRequired = false;
        await loadOwnerData();
        updateAccount();
        closeModal(true);
        toast(setup ? 'تم إنشاء حسابك' : 'تم تسجيل الدخول');
        startPolling();
      } catch (error) { $('#auth-error').textContent = error.message; button.disabled = false; }
    };
  });
}
function updateAccount() {
  $('#account-name').textContent = state.user?.name || 'حسابك الشخصي';
  $('#account-caption').textContent = state.user?.email || 'تسجيل الدخول';
  $('#avatar').textContent = state.user?.name?.slice(0, 1) || 'T';
  $('#nav-count').textContent = state.documents.filter(doc => !doc.archived).length;
}
async function loadOwnerData() {
  if (!state.user) return;
  [state.documents, state.clients, state.settings] = await Promise.all([api('/documents'), api('/clients'), api('/settings')]);
  updateAccount();
}
function field(name, label, value = '', type = 'text', options = {}) {
  const id = `field-${name.replaceAll('.', '-')}`;
  const attributes = Object.entries(options).filter(([key]) => !['full', 'hint', 'options'].includes(key)).map(([key, value]) => value === true ? escapeHtml(key) : `${escapeHtml(key)}="${escapeHtml(value)}"`).join(' ');
  const input = type === 'textarea' ? `<textarea id="${id}" name="${escapeHtml(name)}" ${attributes}>${escapeHtml(value)}</textarea>`
    : type === 'select' ? `<select id="${id}" name="${escapeHtml(name)}" ${attributes}>${options.options.map(([key, text]) => `<option value="${escapeHtml(key)}" ${String(value) === String(key) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select>`
    : `<input id="${id}" name="${escapeHtml(name)}" type="${type}" value="${type === 'file' ? '' : escapeHtml(value)}" ${attributes}>`;
  return `<div class="field ${options.full ? 'full' : ''}"><label for="${id}">${escapeHtml(label)}${options.hint ? `<span>${escapeHtml(options.hint)}</span>` : ''}</label>${input}</div>`;
}
function section(number, title, content, extra = '') {
  return `<section class="form-section"><div class="form-section-heading"><span class="step-number">${String(number).padStart(2, '0')}</span><h2>${escapeHtml(title)}</h2>${extra}</div>${content}</section>`;
}
function pageTitle(title, subtitle, action = true, eyebrow = '') {
  return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow" dir="ltr">${escapeHtml(eyebrow)}</div>` : ''}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${action ? `<button class="btn btn-primary" data-action="new">${icon('plus')}إنشاء مستند جديد</button>` : ''}</div>`;
}
function emptyState(title = 'لم تنشئ أي مستند حتى الآن', description = 'مستنداتك واتفاقاتك القادمة، في مكان واحد.', button = true) {
  return `<div class="empty-state"><div class="empty-icon">${icon('file-text')}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${button ? `<button class="btn" data-action="new">${icon('plus')}إنشاء أول مستند</button>` : ''}</div>`;
}
function art() {
  return `<div class="document-art" aria-hidden="true"><div class="art-paper back"></div><div class="art-paper"><span class="art-brand">TUS3dev.</span><div class="art-line short"></div><div class="art-title">مستند مشروع</div><div class="art-line"></div><div class="art-line short"></div><div class="art-table"><span></span><span></span><span></span></div><div class="art-approved">${icon('check')}</div></div></div>`;
}
function summary(documents) {
  const latest = new Map();
  for (const doc of documents) {
    if (['Cancelled', 'Rejected'].includes(doc.status)) continue;
    if (!latest.has(doc.number) || latest.get(doc.number).revision < doc.revision) latest.set(doc.number, doc);
  }
  const counted = [...latest.values()].filter(doc => doc.content.currency === state.summaryCurrency);
  return counted.reduce((sum, doc) => ({ total: sum.total + doc.totals.total, paid: sum.paid + doc.totals.paid, remaining: sum.remaining + doc.totals.remaining }), { total: 0, paid: 0, remaining: 0 });
}
function renderDashboard() {
  const docs = state.documents.filter(doc => !doc.archived);
  const pending = docs.filter(doc => pendingStatuses.includes(doc.status)).length;
  const approved = docs.filter(doc => doc.status === 'Approved').length;
  const finance = summary(docs);
  const percent = finance.total ? Math.min(100, Math.round(finance.paid / finance.total * 100)) : 0;
  $('#main').innerHTML = `<div class="page-enter">${pageTitle('نظرة عامة', 'أهلًا بك، هذه آخر مستجدات مساحة عملك.', true, 'YOUR WORKSPACE')}<section class="intro-band"><div class="intro-copy"><div class="overline">${icon('sparkles')}التفاصيل الصغيرة تصنع الفرق</div><h2>كل اتفاق، موثّق.</h2><p>تفاصيل واضحة. تعاملات موثوقة. وراحة بال.</p><button class="btn" data-action="new">مستند جديد${icon('arrow-up-left')}</button></div>${art()}</section><div class="stats-grid">${[
    ['إجمالي المستندات', docs.length, 'files', 'جميع مستندات مساحة العمل'],
    ['بانتظار توقيع العميل', pending, 'pen-line', 'مستندات تحتاج إلى اعتماد'],
    ['تم الاعتماد', approved, 'badge-check', 'اتفاقات معتمدة إلكترونيًا'],
    ['إجمالي التعاملات', formatMoney(finance.total, state.summaryCurrency, false), 'wallet', state.summaryCurrency]
  ].map(([label, value, glyph, caption], index) => `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(glyph)}</span></div><div class="stat-value">${value}${index === 3 ? '<small>إجمالي</small>' : ''}</div><div class="stat-foot">${icon(index === 2 ? 'shield-check' : 'minus')}${caption}</div></article>`).join('')}</div><section class="finance-overview"><div class="finance-metric"><div class="finance-label"><span></span>المبالغ المدفوعة</div><div class="finance-number">${formatMoney(finance.paid, state.summaryCurrency, false)}<small>${state.summaryCurrency}</small></div></div><div class="finance-metric"><div class="finance-label"><span class="orange"></span>المبالغ المتبقية</div><div class="finance-number">${formatMoney(finance.remaining, state.summaryCurrency, false)}<small>${state.summaryCurrency}</small></div></div><div class="finance-metric"><div class="finance-label">مرفوضة / ملغية</div><div class="finance-number">${docs.filter(doc => doc.status === 'Rejected').length}<small>/</small>${docs.filter(doc => doc.status === 'Cancelled').length}</div></div><div class="collection"><div class="collection-heading"><span>نسبة التحصيل <select id="summary-currency" aria-label="عملة الإحصائيات" class="currency-select">${['SAR', 'USD', 'AED', 'EUR'].map(currency => `<option ${currency === state.summaryCurrency ? 'selected' : ''}>${currency}</option>`).join('')}</select></span><b>${percent}%</b></div><div class="progress-track"><span style="width:${percent}%"></span></div></div></section><section><div class="section-heading"><div><h2>أحدث المستندات</h2><p>آخر الاتفاقات والمستندات في مساحة عملك</p></div><a class="btn btn-text" href="#documents">عرض الكل${icon('arrow-left')}</a></div>${documentToolbar(docs)}<div id="document-results"></div></section></div>`;
  renderDocumentResults(docs, 5);
  bindDocumentToolbar();
  $('#summary-currency').onchange = event => { state.summaryCurrency = event.target.value; renderDashboard(); refreshIcons(); };
}
function documentToolbar(docs) {
  return `<div class="toolbar"><div class="tabs" role="tablist" aria-label="حالة المستندات">${[['all', 'الكل', docs.length], ['pending', 'بانتظار التوقيع', docs.filter(doc => pendingStatuses.includes(doc.status)).length], ['approved', 'المعتمدة', docs.filter(doc => doc.status === 'Approved').length]].map(([key, title, count]) => `<button class="tab ${state.filters.tab === key ? 'active' : ''}" data-tab="${key}" role="tab" aria-selected="${state.filters.tab === key}">${title}<span>${count}</span></button>`).join('')}</div><div class="toolbar-right"><div class="search-field">${icon('search')}<input id="document-search" placeholder="ابحث عن مستند أو عميل..." aria-label="البحث في المستندات" value="${escapeHtml(state.filters.search)}"></div><button class="btn btn-small" data-action="filters">${icon('sliders-horizontal')}تصفية${Object.entries(state.filters).some(([key, value]) => !['tab', 'search'].includes(key) && value) ? '<span class="small-dot"></span>' : ''}</button></div></div>`;
}
function filteredDocuments(docs) {
  const filters = state.filters;
  return docs.filter(doc => {
    const content = doc.content;
    const haystack = `${doc.number} ${content.client.name} ${content.client.phone} ${content.title} ${content.description} ${content.items.map(item => item.name).join(' ')}`.toLowerCase();
    return (!filters.search || haystack.includes(filters.search.toLowerCase()))
      && (filters.tab !== 'pending' || pendingStatuses.includes(doc.status))
      && (filters.tab !== 'approved' || doc.status === 'Approved')
      && (!filters.type || content.type === filters.type)
      && (!filters.status || doc.status === filters.status)
      && (!filters.from || content.date >= filters.from)
      && (!filters.to || content.date <= filters.to)
      && (!filters.payment || (filters.payment === 'paid' ? doc.totals.remaining <= 0 && doc.totals.total > 0 : doc.totals.remaining > 0));
  });
}
function renderDocumentResults(docs, pageSize = 10) {
  const filtered = filteredDocuments(docs);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.page = Math.min(state.page, pages);
  const paginated = filtered.slice((state.page - 1) * pageSize, state.page * pageSize);
  $('#document-results').innerHTML = `${documentTable(paginated, !docs.length)}<div class="table-footer"><span>${filtered.length ? `${(state.page - 1) * pageSize + 1}–${Math.min(state.page * pageSize, filtered.length)} من ${filtered.length} مستند` : '0 مستندات'}</span><div class="pagination"><button class="icon-button" data-page="previous" ${state.page <= 1 ? 'disabled' : ''} title="الصفحة السابقة" aria-label="الصفحة السابقة">${icon('chevron-right')}</button><span>${state.page}</span><button class="icon-button" data-page="next" ${state.page >= pages ? 'disabled' : ''} title="الصفحة التالية" aria-label="الصفحة التالية">${icon('chevron-left')}</button></div></div>`;
  refreshIcons();
}
function documentTable(docs, trulyEmpty = false) {
  return `<div class="table-wrap"><table class="documents-table"><thead><tr><th>المستند</th><th>العميل</th><th>المبلغ</th><th>الحالة</th><th>تاريخ الإنشاء</th><th></th></tr></thead><tbody>${docs.length ? docs.map(doc => `<tr data-id="${doc.id}" tabindex="0" aria-label="فتح ${escapeHtml(doc.number)}"><td><div class="doc-cell"><span class="doc-cell-icon">${icon(typeInfo[doc.content.type]?.[1] || 'file-text')}</span><div><strong>${escapeHtml(doc.content.title || typeInfo[doc.content.type][0])}</strong><small>${escapeHtml(doc.number)}${doc.revision > 1 ? ` · R${doc.revision}` : ''}</small></div></div></td><td><div class="client-cell"><span class="client-initial">${escapeHtml(doc.content.client.name.slice(0, 1) || '—')}</span>${escapeHtml(doc.content.client.name || 'لم يُحدد بعد')}</div></td><td class="money-cell">${formatMoney(doc.totals.total, doc.content.currency, false)}<small>${doc.content.currency}</small></td><td>${badge(doc.status)}</td><td>${dateLabel(doc.created_at)}</td><td><button class="icon-button" data-open="${doc.id}" aria-label="فتح المستند" title="فتح المستند">${icon('arrow-up-left')}</button></td></tr>`).join('') : `<tr><td colspan="6">${trulyEmpty ? emptyState() : emptyState('لا توجد مستندات مطابقة', 'جرّب تغيير البحث أو خيارات التصفية.', false)}</td></tr>`}</tbody></table></div>`;
}
function bindDocumentToolbar() {
  $('#document-search').oninput = event => { state.filters.search = event.target.value; state.page = 1; updateResults(); };
  $$('[data-tab]').forEach(button => button.onclick = () => {
    state.filters.tab = button.dataset.tab; state.page = 1;
    $$('[data-tab]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
    updateResults();
  });
}
function updateResults() { renderDocumentResults(state.documents.filter(doc => Boolean(doc.archived) === (state.view === 'archive')), state.view === 'dashboard' ? 5 : 10); }
function showFilters() {
  modal('تصفية المستندات', `<form id="filters-form"><div class="filter-grid">${field('filter-type', 'نوع المستند', state.filters.type, 'select', { options: [['', 'جميع الأنواع'], ...Object.entries(typeInfo).map(([key, info]) => [key, info[0]])] })}${field('filter-status', 'الحالة', state.filters.status, 'select', { options: [['', 'جميع الحالات'], ...Object.entries(statusLabels)] })}${field('filter-payment', 'حالة الدفع', state.filters.payment, 'select', { options: [['', 'الكل'], ['paid', 'مدفوع بالكامل'], ['remaining', 'مبلغ متبقٍ']] })}${field('filter-from', 'من تاريخ', state.filters.from, 'date')}${field('filter-to', 'إلى تاريخ', state.filters.to, 'date')}</div><div class="modal-actions"><button class="btn" id="reset-filters" type="button">إعادة تعيين</button><button class="btn btn-primary" type="submit">تطبيق التصفية</button></div></form>`);
  $('#filters-form').onsubmit = event => {
    event.preventDefault();
    for (const key of ['type', 'status', 'payment', 'from', 'to']) state.filters[key] = $(`[name="filter-${key}"]`).value;
    if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) return toast('تاريخ البداية يجب أن يسبق تاريخ النهاية', true);
    state.page = 1; closeModal(); renderCurrentList();
  };
  $('#reset-filters').onclick = () => { state.filters = { tab: 'all', search: '', type: '', status: '', payment: '', from: '', to: '' }; state.page = 1; closeModal(); renderCurrentList(); };
}
function renderCurrentList() {
  if (state.view === 'dashboard') renderDashboard();
  else renderDocuments(state.view === 'archive');
  refreshIcons();
}
function renderDocuments(archive = false) {
  const docs = state.documents.filter(doc => Boolean(doc.archived) === archive);
  $('#main').innerHTML = `<div class="page-enter">${pageTitle(archive ? 'الأرشيف' : 'المستندات', archive ? 'اتفاقات محفوظة، وسجل لا يضيع.' : 'جميع مستنداتك، من أول مسودة إلى آخر اعتماد.', !archive)}${documentToolbar(docs)}<div id="document-results"></div></div>`;
  renderDocumentResults(docs); bindDocumentToolbar();
}

function newContent(client = null) {
  return { type: 'invoice', title: typeInfo.invoice[0], date: isoDate(), dueDate: '', description: '', notes: '', provider: structuredClone(state.settings.provider), client: client || emptyParty(), items: [{ id: uid(), name: '', description: '', quantity: 1, price: 0, discount: 0 }], payments: [], bank: state.settings.banks[0] || null, declaration: state.settings.declarations.invoice || defaultDeclaration('invoice'), currency: 'SAR', logo: state.settings.logo, accent: state.settings.accent };
}
async function createDocument(client = null) {
  if (!await authenticate()) return;
  try {
    const doc = await api('/documents', { method: 'POST', body: newContent(client) });
    location.hash = `editor/${doc.id}`;
  } catch (error) { toast(error.message, true); }
}
function partyFields(party, prefix, provider = false) {
  return `<div class="fields">${field(`${prefix}.name`, provider ? 'الاسم' : 'اسم العميل', party.name, 'text', { required: true, maxlength: 200, placeholder: provider ? 'اسم مقدم الخدمة' : 'الاسم الكامل' })}${field(`${prefix}.company`, provider ? 'المنشأة / العلامة التجارية' : 'اسم الشركة', party.company, 'text', { maxlength: 200, hint: 'اختياري' })}${field(`${prefix}.phone`, 'رقم الجوال', party.phone, 'tel', { maxlength: 40, dir: 'ltr', placeholder: '+966' })}${field(`${prefix}.email`, 'البريد الإلكتروني', party.email, 'email', { dir: 'ltr', maxlength: 200, placeholder: 'name@example.com' })}${field(`${prefix}.taxId`, provider ? 'الرقم الضريبي' : 'الهوية / السجل التجاري', party.taxId, 'text', { maxlength: 80, hint: 'اختياري' })}${provider ? field(`${prefix}.website`, 'الموقع الإلكتروني', party.website, 'text', { dir: 'ltr', maxlength: 200 }) : field(`${prefix}.notes`, 'ملاحظات العميل', party.notes, 'text', { maxlength: 2000, hint: 'اختياري' })}</div>`;
}
function itemRows(items) {
  return items.map((item, index) => `<div class="item-row"><div class="row-label"><span>الخدمة ${index + 1}</span><button class="icon-button" data-remove-item="${index}" type="button" title="حذف الخدمة" aria-label="حذف الخدمة ${index + 1}">${icon('trash-2')}</button></div><div class="fields">${field(`items.${index}.name`, 'اسم المشروع / الخدمة', item.name, 'text', { full: true, maxlength: 200, placeholder: 'مثال: تطوير متجر إلكتروني' })}${field(`items.${index}.description`, 'وصف الخدمة', item.description, 'text', { full: true, maxlength: 2000, hint: 'اختياري' })}<div class="numeric-fields">${field(`items.${index}.quantity`, 'الكمية', item.quantity, 'number', { min: .001, max: 1000000, step: 'any' })}${field(`items.${index}.price`, 'السعر', item.price, 'number', { min: 0, max: 10000000000, step: .01 })}${field(`items.${index}.discount`, 'الخصم', item.discount, 'number', { min: 0, max: 10000000000, step: .01 })}</div></div><div class="row-total"><span>إجمالي الخدمة</span><b data-item-total="${index}">${formatMoney(item.quantity * item.price - item.discount, state.current.content.currency)}</b></div></div>`).join('');
}
function paymentRows(payments) {
  return payments.map((payment, index) => `<div class="payment-row"><div class="row-label"><span>الدفعة ${index + 1}</span><button class="icon-button" type="button" data-remove-payment="${index}" title="حذف الدفعة" aria-label="حذف الدفعة ${index + 1}">${icon('trash-2')}</button></div><div class="fields">${field(`payments.${index}.name`, 'اسم الدفعة', payment.name, 'text', { maxlength: 200 })}${field(`payments.${index}.status`, 'حالة الدفعة', payment.status, 'select', { options: Object.entries(paymentLabels) })}${field(`payments.${index}.amount`, 'المبلغ', payment.amount, 'number', { min: 0, max: 10000000000, step: .01 })}${field(`payments.${index}.percentage`, 'نسبة الدفعة %', payment.percentage, 'number', { min: 0, max: 100, step: .01 })}${field(`payments.${index}.method`, 'طريقة الدفع', payment.method, 'select', { options: Object.entries(methodLabels) })}${field(`payments.${index}.bank`, 'البنك', payment.bank, 'text', { maxlength: 200 })}${field(`payments.${index}.date`, 'تاريخ الدفع / الاستحقاق', payment.date, 'date')}${field(`payments.${index}.reference`, 'رقم العملية / المرجع', payment.reference, 'text', { maxlength: 200 })}${payment.status === 'partial' ? field(`payments.${index}.paidAmount`, 'المدفوع من هذه الدفعة', payment.paidAmount, 'number', { min: 0, max: payment.amount, step: .01, full: true }) : ''}${field(`payments.${index}.note`, 'ملاحظة الدفعة', payment.note, 'text', { full: true, maxlength: 2000 })}</div></div>`).join('');
}
function renderEditor() {
  const doc = state.current;
  if (doc.status !== 'Draft') { location.hash = `document/${doc.id}`; return; }
  const content = doc.content;
  $('#main').innerHTML = `<div class="page-enter"><div class="page-heading editor-heading"><div><h1>إنشاء مستند</h1><div class="save-indicator saved" id="save-indicator">${icon('cloud-check')}تم الحفظ تلقائيًا</div></div><div class="button-row"><a class="btn btn-small" href="#documents">${icon('arrow-right')}المستندات</a><button class="btn btn-small mobile-preview-button" data-action="mobile-preview">${icon('scan-eye')}معاينة المستند</button></div></div><div class="editor-layout"><form class="editor-form" id="document-form">${section(1, 'نوع المستند', `<div class="document-types">${Object.entries(typeInfo).map(([key, [title, glyph]]) => `<button type="button" class="type-option ${content.type === key ? 'active' : ''}" data-type="${key}">${icon(glyph)}${title.replace(' مشروع', '')}</button>`).join('')}</div><div class="fields">${field('number', 'رقم المستند', `${doc.number}${doc.revision > 1 ? ` · Revision ${doc.revision}` : ''}`, 'text', { readonly: true, dir: 'ltr' })}${field('currency', 'العملة', content.currency, 'select', { options: [['SAR', 'ريال سعودي · SAR'], ['USD', 'دولار أمريكي · USD'], ['AED', 'درهم إماراتي · AED'], ['EUR', 'يورو · EUR']] })}${field('title', 'عنوان المستند', content.title, 'text', { full: true, maxlength: 200 })}${field('date', 'تاريخ الإنشاء', content.date, 'date', { required: true })}${field('dueDate', 'تاريخ الاستحقاق', content.dueDate, 'date', { hint: 'اختياري' })}${field('description', 'وصف مختصر للمشروع', content.description, 'textarea', { full: true, maxlength: 4000 })}</div>`)}${section(2, 'بيانات العميل', `${state.clients.length ? field('saved-client', 'اختر عميلًا محفوظًا', '', 'select', { options: [['', 'عميل جديد'], ...state.clients.map(client => [client.id, client.name])] }) + '<br>' : ''}${partyFields(content.client, 'client')}`)}${section(3, 'بيانات مقدم الخدمة', partyFields(content.provider, 'provider', true), `<a href="#settings" class="btn btn-text btn-small">${icon('settings-2')}</a>`)}${section(4, 'المشروع والخدمات', `<div id="item-rows">${itemRows(content.items)}</div><button class="btn btn-small" data-action="add-item" type="button">${icon('plus')}إضافة صف</button>`)}${section(5, 'الدفعات', `<div class="split-options"><button type="button" class="btn btn-small" data-split="50,50">50% / 50%</button><button type="button" class="btn btn-small" data-split="30,40,30">30% / 40% / 30%</button></div><div id="payment-rows">${paymentRows(content.payments)}</div><button class="btn btn-small" data-action="add-payment" type="button">${icon('plus')}إضافة دفعة</button><div class="summary-inline" id="editor-summary"></div>`)}${section(6, 'الحساب البنكي', `${field('saved-bank', 'حساب محفوظ', content.bank?.id || '', 'select', { options: [['', 'بدون حساب / إدخال يدوي'], ...state.settings.banks.map(bank => [bank.id, `${bank.bank} · ${bank.holder}`])] })}<br><div class="fields">${field('bank.bank', 'اسم البنك', content.bank?.bank || '', 'text', { maxlength: 200 })}${field('bank.holder', 'اسم صاحب الحساب', content.bank?.holder || '', 'text', { maxlength: 200 })}${field('bank.iban', 'IBAN', content.bank?.iban || '', 'text', { full: true, dir: 'ltr', maxlength: 50 })}${field('bank.account', 'رقم الحساب', content.bank?.account || '', 'text', { full: true, dir: 'ltr', maxlength: 60, hint: 'اختياري' })}</div>`)}${section(7, 'الإقرار والملاحظات', `<div class="fields">${field('declaration', 'نص الإقرار', content.declaration, 'textarea', { full: true, maxlength: 12000, rows: 6 })}${field('notes', 'ملاحظات إضافية', content.notes, 'textarea', { full: true, maxlength: 4000 })}</div>`)}<div class="form-actions"><button type="button" class="btn" data-action="save">${icon('save')}حفظ كمسودة</button><button type="button" class="btn btn-primary" data-action="generate-link">${icon('link')}إنشاء رابط الإقرار</button></div></form><aside class="preview-column"><div class="preview-toolbar"><span>${icon('scan-eye')}معاينة مباشرة</span><span dir="ltr">A4 · ${content.currency}</span></div><div class="paper-stage" id="live-preview">${paper(doc)}</div><p class="export-note">${badge('Draft')}</p></aside></div></div>`;
  updateEditorSummary();
  $('#document-form').addEventListener('input', onEditorInput);
  $('#document-form').addEventListener('change', onEditorChange);
  $('#document-form').onsubmit = event => event.preventDefault();
  refreshIcons();
}
function setPath(target, path, value) {
  const segments = path.split('.');
  let parent = target;
  for (const segment of segments.slice(0, -1)) { if (parent[segment] == null) parent[segment] = {}; parent = parent[segment]; }
  parent[segments.at(-1)] = value;
}
function onEditorInput(event) {
  const input = event.target;
  if (!input.name || ['number', 'saved-client', 'saved-bank'].includes(input.name)) return;
  setPath(state.current.content, input.name, input.type === 'number' ? Number(input.value || 0) : input.value);
  if (input.name.startsWith('payments.') && ['amount', 'percentage'].includes(input.name.split('.').at(-1))) {
    const index = Number(input.name.split('.')[1]);
    const payment = state.current.content.payments[index];
    const total = calculate(state.current.content).total;
    if (input.name.endsWith('.percentage')) payment.amount = Math.round(total * payment.percentage) / 100;
    else payment.percentage = total ? Math.round(payment.amount / total * 10000) / 100 : 0;
    const sibling = $(`[name="payments.${index}.${input.name.endsWith('.percentage') ? 'amount' : 'percentage'}"]`);
    if (sibling) sibling.value = input.name.endsWith('.percentage') ? payment.amount : payment.percentage;
  }
  markDirty(); updatePreview();
}
function onEditorChange(event) {
  if (event.target.name === 'saved-client') {
    const client = state.clients.find(client => client.id === event.target.value);
    state.current.content.client = client ? structuredClone(client.data) : emptyParty();
    markDirty(); renderEditor();
  } else if (event.target.name === 'saved-bank') {
    state.current.content.bank = structuredClone(state.settings.banks.find(bank => bank.id === event.target.value) || null);
    markDirty(); renderEditor();
  } else if (/^payments\.\d+\.status$/.test(event.target.name)) {
    renderPaymentRows();
  }
}
function renderItemRows() { $('#item-rows').innerHTML = itemRows(state.current.content.items); refreshIcons(); updatePreview(); }
function renderPaymentRows() { $('#payment-rows').innerHTML = paymentRows(state.current.content.payments); refreshIcons(); updatePreview(); }
function updateEditorSummary() {
  const totals = calculate(state.current.content);
  if ($('#editor-summary')) $('#editor-summary').innerHTML = [['قيمة المشروع', totals.total], ['المدفوع', totals.paid], ['المتبقي', totals.remaining]].map(([title, value]) => `<span>${title}<strong>${formatMoney(value, state.current.content.currency)}</strong></span>`).join('');
  state.current.content.items.forEach((item, index) => { const total = $(`[data-item-total="${index}"]`); if (total) total.textContent = formatMoney(item.quantity * item.price - item.discount, state.current.content.currency); });
}
function updatePreview() {
  if ($('#live-preview')) $('#live-preview').innerHTML = paper(state.current);
  updateEditorSummary(); refreshIcons();
}
function markDirty() {
  state.dirty = true;
  saveStatus('جاري الحفظ…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrent().catch(() => {}), 750);
}
function saveStatus(message, saved = false, error = false) {
  const indicator = $('#save-indicator');
  if (!indicator) return;
  indicator.className = `save-indicator ${saved ? 'saved' : ''}`;
  indicator.style.color = error ? 'var(--danger)' : '';
  indicator.innerHTML = `${icon(saved ? 'cloud-check' : error ? 'cloud-off' : 'cloud-upload')}${escapeHtml(message)}`;
  refreshIcons();
}
async function saveCurrent() {
  clearTimeout(state.saveTimer);
  if (!state.current || state.current.status !== 'Draft') return;
  const activeDoc = state.current;
  state.saving = state.saving.catch(() => {}).then(async () => {
    if (!state.dirty || state.current !== activeDoc) return;
    const content = structuredClone(activeDoc.content);
    if (content.bank && !Object.values(content.bank).some(Boolean)) content.bank = null;
    state.dirty = false;
    state.inFlight = true;
    try {
      const saved = await api(`/documents/${activeDoc.id}`, { method: 'PUT', body: { content, version: activeDoc.version } });
      activeDoc.version = saved.version;
      if (!state.dirty) saveStatus('تم الحفظ تلقائيًا', true);
    } catch (error) {
      state.dirty = true; saveStatus('لم يتم الحفظ، أعد المحاولة', false, true); toast(error.message, true); throw error;
    } finally { state.inFlight = false; }
  });
  await state.saving;
  if (state.dirty) return saveCurrent();
}

function partyMarkup(party, label) {
  return `<div><div class="paper-label">${label}</div><h3>${escapeHtml(party.name || '—')}</h3>${[party.company, party.email, party.phone, party.website, party.taxId ? `الرقم التعريفي: ${party.taxId}` : ''].filter(Boolean).map(value => `<p>${escapeHtml(value)}</p>`).join('')}</div>`;
}
function paper(doc) {
  const content = doc.content;
  const totals = calculate(content);
  const signature = doc.signature;
  const currency = content.currency;
  return `<article class="document-paper" style="--doc-accent:${/^#[a-fA-F0-9]{6}$/.test(content.accent) ? content.accent : '#28765a'}" aria-label="معاينة ${escapeHtml(content.title)}"><header class="paper-header"><div>${content.logo ? `<img class="paper-logo" src="${escapeHtml(content.logo)}" alt="شعار مقدم الخدمة">` : ''}<div class="paper-brand">TUS3<span>dev</span>.</div><div class="paper-subbrand">DOCUMENTS THAT MATTER</div></div><div class="paper-title"><h2>${escapeHtml(content.title || typeInfo[content.type][0])}</h2><div class="paper-number">${escapeHtml(doc.number || '—')}${doc.revision > 1 ? ` · Revision ${doc.revision}` : ''}</div>${badge(doc.status)}</div></header><div class="paper-dates"><span>تاريخ الإصدار: ${dateLabel(content.date)}</span>${content.dueDate ? `<span>تاريخ الاستحقاق: ${dateLabel(content.dueDate)}</span>` : ''}</div><section class="paper-parties">${partyMarkup(content.provider, 'مقدم الخدمة')}${partyMarkup(content.client, 'موجّه إلى')}</section>${content.description ? `<div class="paper-desc">${escapeHtml(content.description)}</div>` : ''}<h3 class="paper-section-title">تفاصيل المشروع والخدمات</h3><table class="paper-table"><thead><tr><th>الخدمة / الوصف</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th class="numeric">الإجمالي</th></tr></thead><tbody>${content.items.map(item => `<tr><td>${escapeHtml(item.name || '—')}${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}</td><td>${item.quantity}</td><td class="numeric">${formatMoney(item.price, currency, false)}</td><td class="numeric">${formatMoney(item.discount, currency, false)}</td><td class="numeric">${formatMoney(item.quantity * item.price - item.discount, currency, false)}</td></tr>`).join('')}</tbody></table>${content.payments.length ? `<h3 class="paper-section-title">تفاصيل الدفعات</h3><table class="paper-table paper-payments"><thead><tr><th>الدفعة / التفاصيل</th><th>النسبة</th><th>المبلغ</th><th>الحالة</th></tr></thead><tbody>${content.payments.map(payment => `<tr><td>${escapeHtml(payment.name)}<small>${escapeHtml([methodLabels[payment.method], payment.bank, payment.date ? dateLabel(payment.date) : '', payment.reference ? `مرجع: ${payment.reference}` : ''].filter(Boolean).join(' · '))}</small>${payment.note ? `<small>${escapeHtml(payment.note)}</small>` : ''}</td><td>${payment.percentage}%</td><td class="numeric">${formatMoney(payment.amount, currency, false)}${payment.status === 'partial' ? `<small>المدفوع ${formatMoney(payment.paidAmount, currency)}</small>` : ''}</td><td>${paymentLabels[payment.status]}</td></tr>`).join('')}</tbody></table>` : ''}<section class="paper-financial"><div class="paper-bank">${content.bank?.bank ? `<div class="paper-label">معلومات التحويل البنكي</div><b>${escapeHtml(content.bank.bank)}</b><p>${escapeHtml(content.bank.holder)}</p><div class="iban">${escapeHtml(content.bank.iban)}</div>${content.bank.account ? `<p>رقم الحساب: ${escapeHtml(content.bank.account)}</p>` : ''}` : `<div class="paper-label">العملة المعتمدة</div><b>${currency}</b>`}</div><div class="paper-totals"><div class="total"><span>إجمالي المشروع</span><strong>${formatMoney(totals.total, currency)}</strong></div><div><span>المبلغ المدفوع</span><strong>${formatMoney(totals.paid, currency)}</strong></div><div class="remaining"><span>المبلغ المتبقي</span><strong>${formatMoney(totals.remaining, currency)}</strong></div></div></section><section class="paper-declaration"><h3>الإقرار والاعتماد</h3>${escapeHtml(content.declaration)}</section>${content.client.notes ? `<p class="paper-notes">ملاحظات العميل: ${escapeHtml(content.client.notes)}</p>` : ''}${content.notes ? `<p class="paper-notes">ملاحظات: ${escapeHtml(content.notes)}</p>` : ''}<section class="paper-signature"><div><div class="paper-label">توقيع العميل</div>${signature ? `<img class="signature-image" src="${escapeHtml(signature.image)}" alt="توقيع ${escapeHtml(content.client.name)}">` : '<div class="signature-placeholder">مساحة توقيع العميل</div>'}<p>${escapeHtml(content.client.name || '—')}</p></div><div class="signature-meta">${signature ? `<strong>${icon('badge-check')}معتمد إلكترونيًا</strong>تاريخ الاعتماد: ${dateLabel(doc.approved_at || signature.signed_at, true)}<br><span dir="ltr">${escapeHtml(doc.number)}</span>` : 'بانتظار اعتماد العميل'}</div></section><footer class="paper-footer"><span>Electronically acknowledged through TUS3dev</span><span>Issued via TUS3dev</span></footer></article>`;
}

function expiresField() {
  return `${field('expiry', 'صلاحية رابط العميل', '7', 'select', { options: [['none', 'بدون انتهاء'], ['1', '24 ساعة'], ['3', '3 أيام'], ['7', '7 أيام'], ['custom', 'تاريخ مخصص']] })}<div id="custom-expiry" hidden style="margin-top:15px">${field('custom-date', 'تاريخ ووقت الانتهاء', '', 'datetime-local')}</div>`;
}
async function generateLink() {
  try { await saveCurrent(); } catch { return; }
  modal('إنشاء رابط الإقرار', `<p>سيتم قفل بيانات هذه النسخة أثناء انتظار اعتماد العميل.</p>${expiresField()}<div class="modal-error" id="link-error" role="alert"></div>`, '<button class="btn" data-close-modal>رجوع</button><button class="btn btn-primary" id="create-link">إنشاء الرابط</button>');
  $('[name=expiry]').onchange = event => { $('#custom-expiry').hidden = event.target.value !== 'custom'; };
  $('#create-link').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const choice = $('[name=expiry]').value;
      let expiresAt = null;
      if (choice === 'custom') {
        const date = $('[name=custom-date]').value;
        if (!date || new Date(date).getTime() <= Date.now()) throw new Error('اختر تاريخ انتهاء في المستقبل');
        expiresAt = new Date(date).toISOString();
      } else if (choice !== 'none') expiresAt = new Date(Date.now() + Number(choice) * 86400000).toISOString();
      state.current.link = await api(`/documents/${state.current.id}/link`, { method: 'POST', body: { expiresAt } });
      state.current.status = 'Sent';
      const id = state.current.id;
      closeModal();
      if (location.hash !== `#document/${id}`) { location.hash = `document/${id}`; await route(); }
      else { state.current = await api(`/documents/${id}`); renderDetail(); }
      showLink();
    } catch (error) { if ($('#link-error')) $('#link-error').textContent = error.details?.length ? `${error.message}: ${error.details[0].field}` : error.message; button.disabled = false; }
  };
}
function signingUrl() { return state.current?.link ? `${location.origin}/sign/${state.current.link.token}` : ''; }
async function copyLink() {
  const url = signingUrl();
  if (!url) { toast('لا يوجد رابط نشط لهذا المستند', true); return; }
  try { await navigator.clipboard.writeText(url); toast('تم نسخ رابط العميل'); }
  catch { showLink(); toast('يمكن تحديد الرابط ونسخه يدويًا', true); }
}
function showLink() {
  const url = signingUrl();
  if (!url) { toast('لا يوجد رابط نشط', true); return; }
  modal('رابط العميل جاهز', `<div class="link-state">${icon('shield-check')}رابط خاص بهذه النسخة</div><div class="link-box">${escapeHtml(url)}</div><p>${state.current.link.expiresAt ? `صالح حتى ${dateLabel(state.current.link.expiresAt, true)}` : 'هذا الرابط لا تنتهي صلاحيته تلقائيًا.'}</p><div class="button-row"><button class="btn btn-primary" id="copy-link-modal">${icon('copy')}نسخ الرابط</button><a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}فتح الرابط</a><button class="btn" id="share-link">${icon('share-2')}مشاركة</button></div>${!['Approved', 'Signed', 'Cancelled', 'Rejected'].includes(state.current.status) ? '<div class="modal-actions"><button class="btn btn-danger btn-small" id="revoke-link">إلغاء الرابط</button><button class="btn btn-small" id="regenerate-link">إنشاء رابط جديد</button></div>' : ''}`);
  $('#copy-link-modal').onclick = copyLink;
  $('#share-link').onclick = async () => { try { if (navigator.share) await navigator.share({ title: state.current.content.title, url }); else await copyLink(); } catch (error) { if (error.name !== 'AbortError') toast('تعذرت المشاركة', true); } };
  if ($('#revoke-link')) $('#revoke-link').onclick = async () => {
    if (!await confirmDialog('إلغاء الرابط', 'لن يعمل الرابط السابق، وستعود هذه النسخة إلى المسودة.', 'إلغاء الرابط', true)) return;
    try { await api(`/documents/${state.current.id}/link`, { method: 'DELETE', body: {} }); location.hash = `editor/${state.current.id}`; toast('تم إلغاء الرابط'); } catch (error) { toast(error.message, true); }
  };
  if ($('#regenerate-link')) $('#regenerate-link').onclick = generateLink;
}
function renderDetail() {
  const doc = state.current;
  $('#main').innerHTML = `<div class="page-enter"><div class="page-heading"><div><div class="eyebrow" dir="ltr">${escapeHtml(doc.number)}${doc.revision > 1 ? ` · REVISION ${doc.revision}` : ''}</div><h1>${escapeHtml(doc.content.title)}</h1><p>${escapeHtml(doc.content.client.name)} · ${dateLabel(doc.created_at)}</p></div>${badge(doc.status)}</div><div class="button-row detail-actions" style="margin-bottom:22px"><button class="btn" data-action="mobile-preview">${icon('scan-eye')}معاينة</button>${doc.link ? `<button class="btn" data-action="copy-link">${icon('copy')}نسخ الرابط</button><button class="btn" data-action="show-link">${icon('link')}إدارة الرابط</button>` : ''}${doc.status === 'Draft' ? `<a class="btn btn-primary" href="#editor/${doc.id}">${icon('file-pen-line')}تعديل المسودة</a>` : ''}<button class="btn" data-action="download">${icon('download')}تحميل</button><button class="btn" data-action="archive">${icon('archive')}${doc.archived ? 'استعادة' : 'أرشفة'}</button><button class="btn" data-action="revision">${icon('copy-plus')}إنشاء نسخة معدلة</button><button class="icon-button" data-action="print" title="طباعة" aria-label="طباعة">${icon('printer')}</button>${!['Approved', 'Signed', 'Cancelled'].includes(doc.status) ? `<button class="icon-button" data-action="cancel" title="إلغاء المستند" aria-label="إلغاء المستند">${icon('ban')}</button>` : ''}</div>${doc.status === 'Approved' ? `<div class="readonly-banner">${icon('shield-check')}هذه النسخة معتمدة ومقفلة. أي تعديل يحتاج نسخة جديدة واعتمادًا جديدًا.</div>` : ''}<div class="detail-layout"><div class="paper-stage" id="detail-paper">${paper(doc)}</div><aside class="timeline-panel"><h2>سجل المستند</h2>${doc.events.map(entry => `<div class="timeline-event">${escapeHtml(eventLabels[entry.type] || entry.type)}<time>${dateLabel(entry.created_at, true)}</time>${entry.type === 'approved' ? `<small>المحتوى محفوظ بنسخة ثابتة</small>` : ''}</div>`).join('')}${doc.signature ? `<div class="detail-link"><strong>بصمة النسخة المعتمدة</strong><p dir="ltr">${escapeHtml(doc.signature.content_hash)}</p></div>` : ''}</aside></div></div>`;
  refreshIcons();
}
async function downloadDocument() {
  if (state.current.status !== 'Approved') { toast('يصبح التحميل متاحًا بعد اعتماد العميل', true); return; }
  modal('تحميل المستند المعتمد', `<p>${escapeHtml(state.current.number)} · النسخة ${state.current.revision}</p><div class="fields">${field('export-format', 'صيغة الملف', 'png', 'select', { options: [['png', 'PNG · عالية الجودة'], ['jpeg', 'JPG · حجم أصغر']] })}</div><p class="export-note">A4 · دقة 3× · يتضمن التوقيع وتاريخ الاعتماد</p><div class="modal-error" id="export-error" role="alert"></div>`, `<button class="btn" data-close-modal>رجوع</button><button class="btn btn-primary" id="export-button">${icon('download')}تحميل</button>`);
  $('#export-button').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'جاري تجهيز الصورة…';
    let container;
    try {
      if (!globalThis.htmlToImage) throw new Error('تعذر تحميل أداة التصدير');
      const format = $('[name=export-format]').value;
      container = document.createElement('div');
      container.className = 'export-container';
      container.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:white;';
      container.innerHTML = paper(state.current);
      document.body.append(container);
      const node = $('.document-paper', container);
      node.classList.add('export-paper');
      await document.fonts.ready;
      await Promise.all($$('img', node).map(image => image.decode()));
      const options = { pixelRatio: 3, backgroundColor: '#ffffff', quality: .97, cacheBust: true };
      const url = format === 'png' ? await htmlToImage.toPng(node, options) : await htmlToImage.toJpeg(node, options);
      const link = document.createElement('a');
      link.download = `${state.current.number}-R${state.current.revision}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      link.href = url;
      link.click();
      closeModal(); toast('تم تجهيز النسخة المعتمدة وتحميلها');
    } catch (error) { if ($('#export-error')) $('#export-error').textContent = `تعذر إنشاء الصورة: ${error.message}`; button.disabled = false; button.textContent = 'إعادة المحاولة'; }
    finally { container?.remove(); }
  };
}

function clientDocuments(client) {
  return state.documents.filter(doc => doc.content.client.email && doc.content.client.email === client.email || !client.email && doc.content.client.name === client.name && doc.content.client.phone === client.phone);
}
function renderClients() {
  $('#main').innerHTML = `<div class="page-enter">${pageTitle('العملاء', 'علاقاتك المهنية، وتفاصيل كل تعامل.')}<div class="toolbar"><div class="search-field">${icon('search')}<input id="client-search" placeholder="ابحث باسم العميل أو رقم الجوال..." aria-label="البحث عن عميل"></div><span class="save-indicator">${state.clients.length} عملاء</span></div><div id="client-results"></div></div>`;
  const results = search => {
    const clients = state.clients.filter(client => `${client.name} ${client.phone} ${client.email}`.toLowerCase().includes(search.toLowerCase()));
    $('#client-results').innerHTML = clients.length ? `<div class="client-grid">${clients.map(client => {
      const docs = clientDocuments(client);
      return `<button class="client-card" data-client="${client.id}" style="text-align:right"><span class="client-initial">${escapeHtml(client.name.slice(0, 1))}</span><h3>${escapeHtml(client.name)}</h3><p>${escapeHtml(client.data.company || client.email || client.phone || 'عميل فردي')}</p><div class="client-metrics"><span>المستندات <b>${docs.length}</b></span><span>المعتمدة <b>${docs.filter(doc => doc.status === 'Approved').length}</b></span></div></button>`;
    }).join('')}</div>` : emptyState('لا يوجد عملاء بعد', 'يُحفظ العميل عند إنشاء مستند باسمه.', true);
    refreshIcons();
  };
  results(''); $('#client-search').oninput = event => results(event.target.value);
}
function renderClient(id) {
  const client = state.clients.find(client => client.id === id);
  if (!client) { $('#main').innerHTML = emptyState('العميل غير موجود', '', false); return; }
  const docs = clientDocuments(client);
  const finance = summary(docs);
  $('#main').innerHTML = `<div class="page-enter">${pageTitle(client.name, [client.data.company, client.email, client.phone].filter(Boolean).join(' · '), false)}<div class="button-row" style="margin-bottom:25px"><button class="btn btn-primary" data-action="new-client-document" data-client-id="${client.id}">${icon('plus')}إنشاء مستند لهذا العميل</button><a href="#clients" class="btn">${icon('arrow-right')}العملاء</a></div><div class="stats-grid">${[['عدد المشاريع', new Set(docs.map(doc => doc.content.description || doc.content.title)).size], ['عدد المستندات', docs.length], ['إجمالي التعاملات', formatMoney(finance.total, state.summaryCurrency)], ['المتبقي', formatMoney(finance.remaining, state.summaryCurrency)]].map(([label, value]) => `<article class="stat-card"><div class="stat-top">${label}</div><div class="stat-value" style="font-size:21px">${value}</div></article>`).join('')}</div><div class="section-heading"><h2>مستندات العميل</h2><span class="save-indicator">المدفوع: ${formatMoney(finance.paid, state.summaryCurrency)}</span></div>${documentTable(docs)}</div>`;
}
function renderActivity() {
  const entries = state.documents.flatMap(doc => doc.events.map(event => ({ ...event, doc }))).sort((first, second) => second.created_at.localeCompare(first.created_at));
  $('#main').innerHTML = `<div class="page-enter">${pageTitle('سجل النشاط', 'كل خطوة في رحلة المستند، محفوظة بتاريخها.', false)}<div class="activity-list">${entries.length ? entries.map(entry => `<a class="activity-entry" href="#document/${entry.doc.id}"><span class="stat-icon">${icon(entry.type === 'approved' ? 'badge-check' : entry.type === 'viewed' ? 'eye' : 'file-clock')}</span><div>${escapeHtml(eventLabels[entry.type] || entry.type)}<p>${escapeHtml(entry.doc.content.client.name || 'عميل غير محدد')} · <span dir="ltr">${escapeHtml(entry.doc.number)}</span></p></div><time>${dateLabel(entry.created_at, true)}</time></a>`).join('') : emptyState('لا توجد أحداث حتى الآن', 'سيظهر هنا سجل مستنداتك.', false)}</div></div>`;
}

function settingsBanks() {
  return state.settings.banks.map((bank, index) => `<div class="bank-row"><div class="row-label"><span>الحساب ${index + 1}</span><button type="button" class="icon-button" data-remove-bank="${index}" title="حذف الحساب" aria-label="حذف الحساب">${icon('trash-2')}</button></div><div class="fields">${field(`banks.${index}.bank`, 'اسم البنك', bank.bank, 'text', { maxlength: 200 })}${field(`banks.${index}.holder`, 'صاحب الحساب', bank.holder, 'text', { maxlength: 200 })}${field(`banks.${index}.iban`, 'IBAN', bank.iban, 'text', { maxlength: 50, dir: 'ltr' })}${field(`banks.${index}.account`, 'رقم الحساب', bank.account, 'text', { maxlength: 60, dir: 'ltr' })}</div></div>`).join('');
}
function renderSettings() {
  const settings = state.settings;
  $('#main').innerHTML = `<div class="page-enter settings-layout">${pageTitle('الإعدادات', 'هويتك المهنية، كما تحب أن تظهر.', false)}<form id="settings-form">${section(1, 'الحساب وبيانات التواصل', `${partyFields(settings.provider, 'provider', true)}<p class="export-note">بريد تسجيل الدخول: ${escapeHtml(state.user.email)}</p>`)}${section(2, 'هوية المستند', `<div class="fields">${field('accent', 'لون الهوية', settings.accent, 'color')}${field('numberPrefix', 'بادئة رقم المستند', settings.numberPrefix, 'text', { pattern: '[A-Z0-9-]{1,12}', maxlength: 12, dir: 'ltr' })}${field('logo-file', 'شعار العلامة التجارية', '', 'file', { full: true, accept: 'image/png,image/jpeg,image/webp', hint: 'PNG / JPG / WebP · حتى 1 MB' })}${settings.logo ? `<div class="field full"><img src="${escapeHtml(settings.logo)}" alt="شعار العلامة التجارية" style="max-width:130px;max-height:70px;object-fit:contain"><button type="button" class="btn btn-text btn-small" id="remove-logo">إزالة الشعار</button></div>` : ''}</div>`)}${section(3, 'الحسابات البنكية', `<div id="settings-banks">${settingsBanks()}</div><button type="button" class="btn btn-small" data-action="add-bank">${icon('plus')}إضافة حساب بنكي</button>`)}${section(4, 'نصوص الإقرار الافتراضية', `<div class="fields">${Object.entries(typeInfo).map(([key, info]) => field(`declarations.${key}`, info[0], settings.declarations[key] || defaultDeclaration(key), 'textarea', { full: true, maxlength: 12000 })).join('')}</div>`)}<div class="form-actions"><a class="btn" href="#dashboard">رجوع</a><button class="btn btn-primary" type="submit">${icon('save')}حفظ الإعدادات</button></div><p class="modal-error" id="settings-error" role="alert"></p></form></div>`;
  $('#settings-form').insertAdjacentHTML('beforebegin', `<section class="whatsapp-section"><div class="form-section-heading">${icon('message-circle')}<h2>واتساب</h2></div><div id="whatsapp-status" aria-live="polite">جاري تحميل حالة الاتصال...</div><div id="whatsapp-qr"></div><div class="button-row"><button class="btn btn-primary" type="button" id="whatsapp-connect">${icon('qr-code')}ربط واتساب</button><button class="btn" type="button" id="whatsapp-disconnect" hidden>${icon('unplug')}فصل الحساب</button></div><div class="modal-error" id="whatsapp-error" role="alert"></div><div id="whatsapp-messages"></div></section>`);
  initWhatsapp();
  $('#settings-form').oninput = event => {
    if (!event.target.name || event.target.type === 'file') return;
    setPath(settings, event.target.name, event.target.value);
  };
  $('[name=logo-file]').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 1000000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { toast('اختر صورة PNG أو JPG أو WebP أقل من 1 MB', true); event.target.value = ''; return; }
    try {
      settings.logo = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      toast('تم اختيار الشعار، احفظ الإعدادات لتثبيته');
    } catch { toast('تعذرت قراءة الصورة', true); }
  };
  if ($('#remove-logo')) $('#remove-logo').onclick = () => { settings.logo = ''; renderSettings(); refreshIcons(); };
  $('#settings-form').onsubmit = async event => {
    event.preventDefault();
    const button = $('button[type=submit]', event.target);
    button.disabled = true;
    try {
      settings.declarations = Object.fromEntries(Object.keys(typeInfo).map(type => [type, $(`[name="declarations.${type}"]`).value]));
      state.settings = await api('/settings', { method: 'PUT', body: settings });
      state.user.name = settings.provider.name || state.user.name; updateAccount(); toast('تم حفظ الإعدادات');
    } catch (error) { $('#settings-error').textContent = error.message; toast(error.message, true); }
    finally { button.disabled = false; }
  };
  refreshIcons();
}

function renderWhatsapp(data) {
  if (!$('#whatsapp-status')) return;
  const labels = { disconnected: 'غير متصل', connecting: 'جاري الاتصال...', qr: 'امسح الرمز من واتساب > الأجهزة المرتبطة > ربط جهاز', connected: 'متصل', error: 'تعذر الاتصال' };
  $('#whatsapp-status').innerHTML = `<span class="whatsapp-state ${data.status === 'connected' ? 'connected' : ''}">${icon(data.status === 'connected' ? 'circle-check' : 'circle-dot')}${escapeHtml(labels[data.status] || data.status)}${data.phone ? ` <b dir="ltr">+${escapeHtml(data.phone)}</b>` : ''}</span>`;
  $('#whatsapp-qr').innerHTML = data.qr ? `<img src="${escapeHtml(data.qr)}" width="280" height="280" alt="رمز ربط حساب واتساب">` : '';
  $('#whatsapp-connect').hidden = ['connected', 'connecting', 'qr'].includes(data.status);
  $('#whatsapp-disconnect').hidden = data.status === 'disconnected';
  $('#whatsapp-error').textContent = data.error || '';
  const statuses = { pending: 'بانتظار الإرسال', sending: 'جاري الإرسال', sent: 'تم الإرسال', failed: 'تعذر الإرسال', uncertain: 'تحقق من المحادثة' };
  $('#whatsapp-messages').innerHTML = data.jobs.length ? `<h3>رسائل الاعتماد</h3>${data.jobs.map(job => `<div class="whatsapp-job"><div><strong>${escapeHtml(job.clientName)}</strong><span dir="ltr">${escapeHtml(job.number)}</span><small>${escapeHtml(statuses[job.status])}${job.error ? `: ${escapeHtml(job.error)}` : ''}</small></div>${['failed', 'uncertain'].includes(job.status) ? `<button class="icon-button" type="button" data-whatsapp-retry="${escapeHtml(job.id)}" title="إعادة الإرسال" aria-label="إعادة الإرسال">${icon('send')}</button>` : icon(job.status === 'sent' ? 'check-check' : 'clock')}</div>`).join('')}` : '';
  $$('[data-whatsapp-retry]').forEach(button => { button.onclick = () => {
    const job = data.jobs.find(entry => entry.id === button.dataset.whatsappRetry);
    modal('إعادة إرسال الفاتورة', `${job.status === 'uncertain' ? '<p>قد تكون الرسالة وصلت بالفعل. تحقق من محادثة العميل قبل إعادة الإرسال.</p>' : ''}${field('whatsapp-phone', 'رقم واتساب العميل', job.phone ? `+${job.phone}` : '', 'tel', { dir: 'ltr', maxlength: 40 })}<div id="whatsapp-retry-error" class="modal-error" role="alert"></div>`, `<button class="btn" data-close-modal>رجوع</button><button class="btn btn-primary" id="whatsapp-retry-send">${icon('send')}إرسال</button>`);
    $('#whatsapp-retry-send').onclick = async event => {
      event.currentTarget.disabled = true;
      try { renderWhatsapp(await api(`/whatsapp/messages/${job.id}/retry`, { method: 'POST', body: { phone: $('[name=whatsapp-phone]').value } })); closeModal(); toast('تمت إضافة الفاتورة لطابور الإرسال'); }
      catch (error) { $('#whatsapp-retry-error').textContent = error.message; if ($('#whatsapp-retry-send')) $('#whatsapp-retry-send').disabled = false; }
    };
  }; });
  refreshIcons();
}
function initWhatsapp() {
  clearInterval(whatsappPoll);
  const update = async () => {
    if (state.view !== 'settings' || !$('#whatsapp-status')) { clearInterval(whatsappPoll); return; }
    try { renderWhatsapp(await api('/whatsapp')); }
    catch (error) { if ($('#whatsapp-error')) $('#whatsapp-error').textContent = error.message; }
  };
  $('#whatsapp-connect').onclick = async event => {
    event.currentTarget.disabled = true;
    try { renderWhatsapp(await api('/whatsapp/connect', { method: 'POST', body: {} })); }
    catch (error) { $('#whatsapp-error').textContent = error.message; }
    finally { if ($('#whatsapp-connect')) $('#whatsapp-connect').disabled = false; }
  };
  $('#whatsapp-disconnect').onclick = async () => {
    if (!await confirmDialog('فصل واتساب', 'سيتوقف الإرسال حتى تعيد ربط الحساب. الرسائل المنتظرة ستبقى محفوظة.', 'فصل الحساب', true)) return;
    try { renderWhatsapp(await api('/whatsapp/disconnect', { method: 'POST', body: {} })); }
    catch (error) { if ($('#whatsapp-error')) $('#whatsapp-error').textContent = error.message; }
  };
  void update();
  whatsappPoll = setInterval(update, 3000);
}

async function route() {
  const sequence = ++state.routeSequence;
  if (state.view === 'editor' && (state.dirty || state.inFlight)) {
    try { await saveCurrent(); } catch { return; }
  }
  const [view = 'dashboard', id] = (location.hash.slice(1) || 'dashboard').split('/');
  const protectedViews = ['editor', 'document', 'settings', 'client'];
  if (protectedViews.includes(view) && !state.user && !await authenticate()) { location.hash = 'dashboard'; return; }
  if (sequence !== state.routeSequence) return;
  state.view = view;
  state.dirty = false;
  const titles = { dashboard: 'نظرة عامة', documents: 'المستندات', archive: 'الأرشيف', clients: 'العملاء', client: 'بيانات العميل', settings: 'الإعدادات', activity: 'سجل النشاط', editor: 'إنشاء مستند', document: 'تفاصيل المستند' };
  $('#breadcrumb-current').textContent = titles[view] || 'نظرة عامة';
  document.title = `TUS3dev | ${titles[view] || 'مساحة العمل'}`;
  $$('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === view || ['editor', 'document'].includes(view) && link.dataset.nav === 'documents' || view === 'client' && link.dataset.nav === 'clients'));
  try {
    if (['editor', 'document'].includes(view)) {
      $('#main').innerHTML = `<div class="skeleton"></div><div class="skeleton large"></div>`;
      const doc = await api(`/documents/${encodeURIComponent(id || '')}`);
      if (sequence !== state.routeSequence) return;
      state.current = doc;
      if (view === 'editor') renderEditor(); else renderDetail();
    } else {
      if (state.user) await loadOwnerData();
      if (sequence !== state.routeSequence) return;
      if (view === 'documents' || view === 'archive') renderDocuments(view === 'archive');
      else if (view === 'clients') renderClients();
      else if (view === 'client') renderClient(id);
      else if (view === 'activity') renderActivity();
      else if (view === 'settings') renderSettings();
      else { state.view = 'dashboard'; renderDashboard(); }
    }
    refreshIcons();
    globalThis.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) { $('#main').innerHTML = `<div class="error-page">${icon('circle-alert')}<h1>${escapeHtml(error.message)}</h1><p><a class="btn" href="#dashboard">العودة للرئيسية</a></p></div>`; refreshIcons(); }
}

$('#main').addEventListener('click', async event => {
  const row = event.target.closest('[data-id]');
  if (row) { location.hash = `document/${row.dataset.id}`; return; }
  const client = event.target.closest('[data-client]');
  if (client) { location.hash = `client/${client.dataset.client}`; return; }
  const type = event.target.closest('[data-type]');
  if (type) {
    const content = state.current.content;
    content.type = type.dataset.type; content.title = typeInfo[content.type][0]; content.declaration = state.settings.declarations[content.type] || defaultDeclaration(content.type);
    markDirty(); renderEditor(); return;
  }
  const removeItem = event.target.closest('[data-remove-item]');
  if (removeItem) { state.current.content.items.splice(Number(removeItem.dataset.removeItem), 1); markDirty(); renderItemRows(); return; }
  const removePayment = event.target.closest('[data-remove-payment]');
  if (removePayment) { state.current.content.payments.splice(Number(removePayment.dataset.removePayment), 1); markDirty(); renderPaymentRows(); return; }
  const split = event.target.closest('[data-split]');
  if (split) {
    if (state.current.content.payments.length && !await confirmDialog('استبدال جدول الدفعات', 'سيتم استبدال الدفعات الحالية بالتقسيم المحدد.', 'استبدال')) return;
    const total = calculate(state.current.content).total;
    let assigned = 0;
    const percentages = split.dataset.split.split(',').map(Number);
    state.current.content.payments = percentages.map((percentage, index) => {
      const amount = index === percentages.length - 1 ? Math.round((total - assigned) * 100) / 100 : Math.round(total * percentage) / 100;
      assigned += amount;
      return { id: uid(), name: index === 0 ? 'عند بدء المشروع' : index === percentages.length - 1 ? 'عند التسليم' : 'أثناء التنفيذ', bank: '', method: 'bank', date: '', amount, percentage, status: 'unpaid', paidAmount: 0, reference: '', note: '' };
    });
    markDirty(); renderPaymentRows(); return;
  }
  const removeBank = event.target.closest('[data-remove-bank]');
  if (removeBank) { state.settings.banks.splice(Number(removeBank.dataset.removeBank), 1); $('#settings-banks').innerHTML = settingsBanks(); refreshIcons(); return; }
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) { state.page += pageButton.dataset.page === 'next' ? 1 : -1; updateResults(); return; }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  try {
    if (action === 'new') { actionButton.disabled = true; await createDocument(); actionButton.disabled = false; }
    if (action === 'new-client-document') await createDocument(structuredClone(state.clients.find(client => client.id === actionButton.dataset.clientId).data));
    if (action === 'filters') showFilters();
    if (action === 'add-item') { state.current.content.items.push({ id: uid(), name: '', description: '', quantity: 1, price: 0, discount: 0 }); markDirty(); renderItemRows(); }
    if (action === 'add-payment') { state.current.content.payments.push({ id: uid(), name: `الدفعة ${state.current.content.payments.length + 1}`, bank: '', method: 'bank', date: '', amount: 0, percentage: 0, status: 'unpaid', paidAmount: 0, reference: '', note: '' }); markDirty(); renderPaymentRows(); }
    if (action === 'save') { await saveCurrent(); toast('تم حفظ المسودة'); }
    if (action === 'generate-link') await generateLink();
    if (action === 'mobile-preview') modal('معاينة المستند', `<div class="paper-stage">${paper(state.current)}</div>`, '', true);
    if (action === 'copy-link') await copyLink();
    if (action === 'show-link') showLink();
    if (action === 'download') await downloadDocument();
    if (action === 'print') globalThis.print();
    if (action === 'revision' && await confirmDialog('إنشاء نسخة معدلة', 'ستبقى النسخة الحالية كما هي. ستبدأ النسخة الجديدة كمسودة وتحتاج إلى اعتماد العميل من جديد.', 'إنشاء النسخة')) {
      const doc = await api(`/documents/${state.current.id}/revision`, { method: 'POST', body: {} });
      location.hash = `editor/${doc.id}`; toast('تم إنشاء نسخة جديدة');
    }
    if (action === 'cancel' && await confirmDialog('إلغاء المستند', 'لن يتمكن العميل من اعتماد هذا المستند، وسيبقى محفوظًا في سجلاتك.', 'إلغاء المستند', true)) {
      await api(`/documents/${state.current.id}/action`, { method: 'POST', body: { action: 'cancel' } }); await route(); toast('تم إلغاء المستند');
    }
    if (action === 'archive') {
      await api(`/documents/${state.current.id}/action`, { method: 'POST', body: { action: state.current.archived ? 'unarchive' : 'archive' } }); await route(); toast(state.current.archived ? 'تمت أرشفة المستند' : 'تمت استعادة المستند');
    }
    if (action === 'add-bank') { state.settings.banks.push({ id: uid(), bank: '', holder: '', iban: '', account: '' }); $('#settings-banks').innerHTML = settingsBanks(); refreshIcons(); }
  } catch (error) { toast(error.message, true); }
});
$('#main').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.matches('tr[data-id]')) { event.preventDefault(); location.hash = `document/${event.target.dataset.id}`; } });
$('#theme-button').onclick = () => {
  const dark = document.body.classList.toggle('dark');
  localStorage.setItem('tus-theme', dark ? 'dark' : 'light');
  $('#theme-button').innerHTML = icon(dark ? 'sun' : 'moon'); refreshIcons();
};
$('#account-button').onclick = async () => {
  if (!state.user) { if (await authenticate()) await route(); return; }
  if (await confirmDialog('تسجيل الخروج', 'سيتم حفظ المسودة قبل تسجيل الخروج.', 'تسجيل الخروج')) {
    try {
      await saveCurrent(); await api('/logout', { method: 'POST', body: {} });
      state.user = null; state.csrf = ''; state.documents = []; state.clients = []; state.settings = emptySettings(); state.current = null;
      clearInterval(state.poll); updateAccount(); location.hash = 'dashboard'; await route(); toast('تم تسجيل الخروج');
    } catch (error) { toast(error.message, true); }
  }
};
function showNotifications() {
  const events = state.documents.flatMap(doc => doc.events.filter(event => ['viewed', 'approved', 'rejected'].includes(event.type)).map(event => ({ ...event, doc }))).sort((first, second) => second.created_at.localeCompare(first.created_at));
  modal('الإشعارات', events.length ? `<div class="activity-list">${events.slice(0, 15).map(event => `<a class="activity-entry notification-link" href="#document/${event.doc.id}"><span class="stat-icon">${icon(event.type === 'approved' ? 'badge-check' : 'eye')}</span><div>${escapeHtml(event.doc.content.client.name)} · ${escapeHtml(eventLabels[event.type])}<p dir="ltr">${escapeHtml(event.doc.number)}</p><p>${dateLabel(event.created_at, true)}</p></div></a>`).join('')}</div>` : emptyState('لا توجد إشعارات جديدة', 'ستظهر هنا مشاهدات العملاء واعتماداتهم.', false));
  $$('.notification-link').forEach(link => link.onclick = () => closeModal());
  if (state.user) localStorage.setItem(`tus-seen-${state.user.id}`, new Date().toISOString());
  $('#notification-dot').hidden = true;
}
$('#notification-button').onclick = showNotifications;
function startPolling() {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (!state.user || document.hidden || document.body.classList.contains('client-mode')) return;
    try {
      const docs = await api('/documents');
      const lastSeen = localStorage.getItem(`tus-seen-${state.user.id}`) || '';
      const newEvents = docs.flatMap(doc => doc.events.filter(event => ['viewed', 'approved', 'rejected'].includes(event.type) && event.created_at > lastSeen));
      const previous = new Set(state.documents.flatMap(doc => doc.events.map(event => `${doc.id}:${event.type}:${event.created_at}`)));
      const freshApproval = docs.find(doc => doc.events.some(event => event.type === 'approved' && !previous.has(`${doc.id}:${event.type}:${event.created_at}`)));
      state.documents = docs; updateAccount(); $('#notification-dot').hidden = !newEvents.length;
      if (freshApproval) toast(`قام ${freshApproval.content.client.name} باعتماد المستند ${freshApproval.number}`);
      if (['dashboard', 'documents', 'archive'].includes(state.view) && !$('#document-search')?.value && !$('#modal-root').children.length) renderCurrentList();
      if (state.view === 'document' && state.current && docs.find(doc => doc.id === state.current.id)?.status !== state.current.status) {
        state.current = await api(`/documents/${state.current.id}`); renderDetail();
      }
    } catch (error) { if (error.status === 401) { clearInterval(state.poll); toast('انتهت جلسة الدخول. أعد تسجيل الدخول', true); } }
  }, 15000);
}

async function initClient(token) {
  document.body.classList.add('client-mode');
  $('#app-shell').innerHTML = `<main class="client-shell" id="client-main"><header class="client-topbar"><a class="brand" href="/index.html"><span class="brand-symbol">${icon('command')}</span><span class="brand-word" dir="ltr">TUS3<span>dev</span><span class="brand-dot">.</span></span></a><span>${icon('shield-check')}مستند خاص</span></header><div id="client-content"><div class="skeleton"></div><div class="skeleton large"></div></div></main>`;
  document.title = 'TUS3dev | مراجعة واعتماد المستند';
  refreshIcons();
  try { state.current = await api(`/sign/${encodeURIComponent(token)}`); renderClientSigning(token); }
  catch (error) { $('#client-content').innerHTML = `<div class="error-page">${icon('file-warning')}<h1>${escapeHtml(error.message)}</h1><p>يرجى التواصل مع مقدم الخدمة.</p></div>`; refreshIcons(); }
}
function renderClientSigning(token) {
  signatureObserver?.disconnect();
  state.pad?.off();
  const doc = state.current;
  const approved = doc.status === 'Approved';
  const rejected = doc.status === 'Rejected';
  $('#client-content').innerHTML = `${approved ? `<section class="success-block"><div class="success-check">${icon('check')}</div><h2>تم اعتماد المستند بنجاح</h2><p>شكرًا لك، تم تسجيل توقيعك وموافقتك.<br><span dir="ltr">${escapeHtml(doc.number)}</span></p><div class="button-row"><button class="btn" id="client-download">${icon('download')}تحميل النسخة المعتمدة</button><button class="btn" id="client-print">${icon('printer')}طباعة</button></div></section>` : `<div class="client-heading"><div class="eyebrow" dir="ltr">REVIEW & ACKNOWLEDGE</div><h1>مراجعة واعتماد المستند</h1><p>مرحبًا ${escapeHtml(doc.content.client.name)}، يرجى مراجعة تفاصيل المستند بالكامل قبل الاعتماد.</p></div><div class="client-identity">${icon('user-check')}<div><small>يرجى التأكد أن المستند موجّه إليك</small><strong>${escapeHtml(doc.content.client.name)}</strong></div></div>`}<div class="paper-stage" id="client-document">${paper(doc)}</div>${!approved && !rejected ? `<section class="sign-section"><h2>الإقرار والتوقيع</h2><label class="check-row"><input type="checkbox" id="accept-terms"><span>قرأت جميع تفاصيل المستند وأوافق على المعلومات الواردة فيه.</span></label><div class="signature-canvas-wrap"><span class="sign-watermark">توقيع العميل · ${escapeHtml(doc.content.client.name)}</span><canvas id="signature-canvas" aria-label="مساحة رسم توقيع العميل"></canvas></div><div class="signature-tools"><div class="button-row"><button class="icon-button" id="signature-undo" title="تراجع" aria-label="تراجع">${icon('undo-2')}</button><button class="icon-button" id="signature-redo" title="إعادة" aria-label="إعادة">${icon('redo-2')}</button><button class="icon-button" id="signature-clear" title="مسح التوقيع" aria-label="مسح التوقيع">${icon('eraser')}</button></div><button class="btn" id="confirm-signature" disabled>${icon('check')}اعتماد التوقيع</button></div><p class="save-indicator" id="signature-state" style="margin-top:12px"></p><div class="sign-submit"><span class="sign-lock-label">${icon('lock-keyhole')}ستُحفظ موافقتك مع هذه النسخة من المستند.</span><button class="btn btn-text" id="reject-document">رفض المستند</button><button class="btn btn-primary" id="approve-document" disabled>${icon('badge-check')}اعتماد وإرسال المستند</button></div></section>` : rejected ? '<div class="readonly-banner" style="margin-top:25px">تم رفض هذا المستند. يرجى التواصل مع مقدم الخدمة.</div>' : ''}`;
  refreshIcons();
  if (approved) { $('#client-download').onclick = downloadDocument; $('#client-print').onclick = () => globalThis.print(); return; }
  if (rejected) return;
  if (!globalThis.SignaturePad) { toast('تعذر تحميل لوحة التوقيع. أعد تحميل الصفحة', true); return; }
  const canvas = $('#signature-canvas');
  const pad = new SignaturePad(canvas, { penColor: '#202d27', minWidth: 1.1, maxWidth: 2.7, throttle: 8, minDistance: 2 });
  state.pad = pad; state.redo = []; state.signatureConfirmed = false;
  const resize = () => {
    const data = pad.toData();
    const ratio = Math.max(globalThis.devicePixelRatio || 1, 1);
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    if (canvas.width === Math.round(width * ratio) && canvas.height === Math.round(height * ratio)) return;
    const previousWidth = canvas.width / ratio;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.getContext('2d').scale(ratio, ratio);
    if (previousWidth && data.length) {
      const scale = width / previousWidth;
      for (const stroke of data) for (const point of stroke.points) { point.x *= scale; point.y *= Math.min(1, scale); }
    }
    pad.clear(); pad.fromData(data);
  };
  resize(); signatureObserver = new ResizeObserver(resize); signatureObserver.observe(canvas.parentElement);
  const update = () => {
    $('#signature-undo').disabled = pad.isEmpty() || state.signatureConfirmed;
    $('#signature-redo').disabled = !state.redo.length || state.signatureConfirmed;
    $('#signature-clear').disabled = pad.isEmpty();
    $('#confirm-signature').disabled = pad.isEmpty() || state.signatureConfirmed;
    $('#approve-document').disabled = !$('#accept-terms').checked || !state.signatureConfirmed || pad.isEmpty();
  };
  pad.addEventListener('endStroke', () => { state.redo = []; state.signatureConfirmed = false; update(); });
  $('#signature-undo').onclick = () => { const data = pad.toData(); if (data.length) { state.redo.push(data.pop()); pad.clear(); pad.fromData(data); } update(); };
  $('#signature-redo').onclick = () => { const stroke = state.redo.pop(); if (stroke) pad.fromData([...pad.toData(), stroke]); update(); };
  $('#signature-clear').onclick = () => { pad.on(); pad.clear(); state.redo = []; state.signatureConfirmed = false; $('#signature-state').textContent = ''; update(); };
  $('#confirm-signature').onclick = () => { if (pad.isEmpty()) return; state.signatureConfirmed = true; pad.off(); $('#signature-state').textContent = 'تم تثبيت التوقيع. يمكنك مسحه لإعادة التوقيع قبل الإرسال.'; update(); };
  $('#accept-terms').onchange = update;
  $('#approve-document').onclick = async () => {
    if (!state.signatureConfirmed || pad.isEmpty() || !$('#accept-terms').checked) return;
    if (!await confirmDialog('تأكيد اعتماد المستند', 'بعد اعتماد المستند سيتم تسجيل موافقتك وتوقيعك على المعلومات الموضحة ولن تتمكن من تعديل التوقيع بعد الإرسال.', 'تأكيد الاعتماد')) return;
    const button = $('#approve-document'); button.disabled = true; button.textContent = 'جاري اعتماد المستند…';
    try {
      state.current = await api(`/sign/${token}`, { method: 'POST', body: { accepted: true, signature: pad.toDataURL('image/png'), signerName: doc.content.client.name } });
      state.signed = true; renderClientSigning(token); globalThis.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) { toast(error.message, true); button.textContent = 'اعتماد وإرسال المستند'; update(); }
  };
  $('#reject-document').onclick = () => {
    modal('رفض المستند', `${field('reject-reason', 'سبب الرفض', '', 'textarea', { maxlength: 2000, minlength: 3 })}<div class="modal-error" id="reject-error"></div>`, '<button class="btn" data-close-modal>رجوع</button><button class="btn btn-danger" id="confirm-reject">تأكيد الرفض</button>');
    $('#confirm-reject').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      try { await api(`/sign/${token}/reject`, { method: 'POST', body: { reason: $('[name=reject-reason]').value } }); closeModal(); state.current.status = 'Rejected'; renderClientSigning(token); }
      catch (error) { $('#reject-error').textContent = error.message; button.disabled = false; }
    };
  };
  update();
}

async function init() {
  if (globalThis.TUS3DEV_IMAGE_RENDER) return;
  try { if (localStorage.getItem('tus-theme') === 'dark') { document.body.classList.add('dark'); $('#theme-button').innerHTML = icon('sun'); } } catch {}
  const token = location.pathname.match(/^\/sign\/([\w-]+)$/)?.[1];
  if (token) { await initClient(token); return; }
  const mobileAccount = document.createElement('button');
  mobileAccount.className = 'icon-button mobile-only';
  mobileAccount.title = 'الحساب والإعدادات';
  mobileAccount.setAttribute('aria-label', 'الحساب والإعدادات');
  mobileAccount.innerHTML = icon('circle-user-round');
  $('.header-actions').append(mobileAccount);
  mobileAccount.onclick = async () => {
    if (!state.user) { if (await authenticate()) await route(); return; }
    modal('حسابك', `<p>${escapeHtml(state.user.name)}<br>${escapeHtml(state.user.email)}</p><div class="button-row"><a class="btn" id="mobile-settings" href="#settings">${icon('settings-2')}الإعدادات</a><button class="btn" id="mobile-logout">${icon('log-out')}تسجيل الخروج</button></div>`);
    $('#mobile-settings').onclick = () => closeModal();
    $('#mobile-logout').onclick = () => { closeModal(); $('#account-button').click(); };
  };
  $('#today').textContent = dateLabel(new Date().toISOString()); $('#year').textContent = new Date().getFullYear();
  refreshIcons();
  try {
    const session = await api('/session');
    Object.assign(state, session);
    if (state.user) { await loadOwnerData(); startPolling(); }
    updateAccount(); await route();
  } catch (error) {
    renderDashboard(); toast(`${error.message}. شغّل الخادم باستخدام npm start`, true);
  }
  globalThis.addEventListener('hashchange', route);
  globalThis.addEventListener('beforeunload', event => { if (state.dirty || state.inFlight) { event.preventDefault(); event.returnValue = ''; } });
}
init();