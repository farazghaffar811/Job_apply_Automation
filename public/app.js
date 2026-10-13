const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Ready for review',
  applied: 'Applied',
  no_opening: 'No opening',
  manual: 'Needs you',
  skipped: 'Skipped',
};

const state = { user: null, companies: [], config: { linkedin: false }, authMode: 'login', editing: null };

// ---------- helpers ----------

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const formData = (form) => Object.fromEntries(new FormData(form));

function statusOptions(select, selected, withAll = false) {
  select.replaceChildren(
    withAll ? el('option', { value: '' }, 'All statuses') : null,
    ...Object.entries(STATUS_LABELS).map(([value, label]) => el('option', { value, selected: value === selected ? '' : null }, label)),
  );
}

// ---------- sign-in ----------

function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#linkedin-btn').classList.toggle('disabled', !state.config.linkedin);
  $('#linkedin-hint').hidden = state.config.linkedin;
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$('[data-auth]').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('#name-field').hidden = mode === 'login';
  $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').hidden = true;
}

$$('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#auth-error');
  error.hidden = true;
  try {
    const { user } = await api(`/api/${state.authMode}`, { method: 'POST', body: formData(e.target) });
    e.target.reset();
    await enter(user);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  state.user = null;
  state.companies = [];
  showAuth();
});

// ---------- shell ----------

async function enter(user) {
  state.user = user;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  renderUser();
  await loadCompanies();
}

function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

$$('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) showView(goto.dataset.goto);
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText($(`#${copy.dataset.copy}`).value)
      .then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it manually.', true));
  }
});

function renderUser() {
  const u = state.user;
  $('#who-name').textContent = u.name || u.email;

  const form = $('#profile-form');
  for (const field of form.elements) if (field.name) field.value = u.profile[field.name] || '';

  $('#resume-status').textContent = u.resume
    ? `${u.resume.name}, uploaded ${new Date(u.resume.uploadedAt).toLocaleDateString()}`
    : 'No resume uploaded yet. PDF, DOC or DOCX, up to 8 MB.';
  $('#resume-view').hidden = !u.resume;
  $('#resume-remove').hidden = !u.resume;

  const link = $('#linkedin-link');
  link.hidden = u.linkedinLinked;
  link.classList.toggle('disabled', !state.config.linkedin);
  $('#linkedin-status').textContent = u.linkedinLinked
    ? 'Connected. You can sign in with LinkedIn.'
    : state.config.linkedin
      ? 'Connect LinkedIn so you can sign in with it.'
      : 'Add your LinkedIn app keys to .env to turn this on (see .env.example).';

  $('#token').value = u.apiToken;
  $('#resume-path').value = u.resume ? u.resume.path : 'Upload a resume first';
  $('#endpoints').textContent = [
    'Header:  Authorization: Bearer <token>',
    '',
    `GET    ${location.origin}/api/me`,
    `GET    ${location.origin}/api/companies?status=todo`,
    `PATCH  ${location.origin}/api/companies/:id`,
    '         { status, careersUrl, role, notes }',
    `GET    ${location.origin}/api/resume`,
    '',
    `status: ${Object.keys(STATUS_LABELS).join(' | ')}`,
  ].join('\n');
  $('#prompt').value = [
    `Work through my Job Apply Hub queue at ${location.origin} using Claude in Chrome.`,
    'Read my profile from /api/me and the companies with status "todo" from /api/companies (Bearer token is on the Automation tab).',
    'For each company: open its website, find the careers page, and look for open roles that match my target roles.',
    'If there is a match, fill the application form with my profile details and attach my resume, then set the row to "review" with the job URL and role, and stop for my approval before submitting.',
    'If nothing matches set "no_opening". If the form needs an account, password or CAPTCHA set "manual" with a note.',
    'After I approve and the application is sent, set the row to "applied".',
  ].join('\n');
}

// ---------- profile + resume ----------

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    state.user = (await api('/api/profile', { method: 'PUT', body: formData(e.target) })).user;
    renderUser();
    toast('Details saved');
  } catch (err) { toast(err.message, true); }
});

$('#resume-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    state.user = (await api('/api/resume', { method: 'POST', body: new FormData(e.target) })).user;
    e.target.reset();
    renderUser();
    toast('Resume uploaded');
  } catch (err) { toast(err.message, true); }
});

$('#resume-remove').addEventListener('click', async () => {
  if (!confirm('Remove your uploaded resume?')) return;
  try {
    state.user = (await api('/api/resume', { method: 'DELETE' })).user;
    renderUser();
    toast('Resume removed');
  } catch (err) { toast(err.message, true); }
});

$('#rotate').addEventListener('click', async () => {
  if (!confirm('Replace the token? The current one stops working.')) return;
  try {
    state.user = (await api('/api/token/rotate', { method: 'POST' })).user;
    renderUser();
    toast('New token created');
  } catch (err) { toast(err.message, true); }
});

// ---------- companies ----------

async function loadCompanies() {
  state.companies = (await api('/api/companies')).companies;
  renderFilters();
  renderCompanies();
}

function renderFilters() {
  const size = $('#filter-size');
  const current = size.value;
  const sizes = [...new Set(state.companies.map((c) => c.size).filter(Boolean))];
  size.replaceChildren(el('option', { value: '' }, 'All sizes'), ...sizes.map((s) => el('option', { value: s }, s)));
  size.value = sizes.includes(current) ? current : '';
}

function renderStats() {
  const count = (s) => state.companies.filter((c) => c.status === s).length;
  const stats = [
    [state.companies.length, 'Companies'],
    [count('applied'), 'Applied'],
    [count('review'), 'Ready for review'],
    [count('manual'), 'Need you'],
    [count('todo') + count('in_progress'), 'Still to do'],
  ];
  $('#stats').replaceChildren(...stats.map(([n, label]) => el('div', { class: 'stat' }, el('b', {}, String(n)), el('span', {}, label))));
}

function extLink(href, label) {
  return href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : null;
}

function renderCompanies() {
  renderStats();
  const q = $('#search').value.trim().toLowerCase();
  const status = $('#filter-status').value;
  const size = $('#filter-size').value;
  const visible = state.companies.filter((c) =>
    (!status || c.status === status) &&
    (!size || c.size === size) &&
    (!q || [c.name, c.type, c.location, c.role, c.notes].some((v) => (v || '').toLowerCase().includes(q))));

  $('#rows').replaceChildren(...visible.map((c) => {
    const select = el('select', { 'aria-label': `Status for ${c.name}`, dataset: { status: c.status } });
    statusOptions(select, c.status);
    select.addEventListener('change', () => updateCompany(c.id, { status: select.value }));

    return el('tr', {},
      el('td', {}, el('strong', {}, c.name), c.type ? el('small', {}, c.type) : null),
      el('td', {}, c.size),
      el('td', {}, c.location),
      el('td', {}, el('div', { class: 'links' },
        extLink(c.website, 'Website'), extLink(c.linkedin, 'LinkedIn'), extLink(c.careersUrl, 'Careers'))),
      el('td', {}, select, c.appliedAt ? el('small', {}, `on ${new Date(c.appliedAt).toLocaleDateString()}`) : null),
      el('td', { class: 'notes' }, c.role ? el('strong', {}, c.role) : null, c.notes ? el('small', {}, c.notes) : null),
      el('td', {}, el('button', { type: 'button', class: 'btn ghost', onclick: () => openDialog(c) }, 'Edit')),
    );
  }));

  const none = state.companies.length === 0;
  $('#empty').hidden = visible.length > 0;
  $('#empty p').textContent = none ? 'No companies yet.' : 'No companies match these filters.';
  $('#empty .btn').hidden = !none;
}

async function updateCompany(id, changes) {
  try {
    const { company } = await api(`/api/companies/${id}`, { method: 'PATCH', body: changes });
    state.companies = state.companies.map((c) => (c.id === id ? company : c));
    renderCompanies();
  } catch (err) {
    toast(err.message, true);
    renderCompanies();
  }
}

['input', 'change'].forEach((evt) => $('.toolbar').addEventListener(evt, renderCompanies));

// ---------- company dialog ----------

const dialog = $('#company-dialog');
const companyForm = $('#company-form');

function openDialog(company = null) {
  state.editing = company;
  $('#dialog-title').textContent = company ? 'Edit company' : 'Add company';
  $('#dialog-delete').hidden = !company;
  $('#dialog-error').hidden = true;
  companyForm.reset();
  statusOptions(companyForm.elements.status, company ? company.status : 'todo');
  if (company) for (const field of companyForm.elements) if (field.name && field.name !== 'status') field.value = company[field.name] || '';
  dialog.showModal();
}

$('#add-company').addEventListener('click', () => openDialog());
$('#dialog-cancel').addEventListener('click', () => dialog.close());

companyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(companyForm);
  try {
    if (state.editing) {
      const { company } = await api(`/api/companies/${state.editing.id}`, { method: 'PATCH', body });
      state.companies = state.companies.map((c) => (c.id === company.id ? company : c));
    } else {
      state.companies.push((await api('/api/companies', { method: 'POST', body })).company);
    }
    dialog.close();
    renderFilters();
    renderCompanies();
    toast('Saved');
  } catch (err) {
    $('#dialog-error').textContent = err.message;
    $('#dialog-error').hidden = false;
  }
});

$('#dialog-delete').addEventListener('click', async () => {
  if (!confirm(`Delete ${state.editing.name} from your list?`)) return;
  try {
    await api(`/api/companies/${state.editing.id}`, { method: 'DELETE' });
    state.companies = state.companies.filter((c) => c.id !== state.editing.id);
    dialog.close();
    renderFilters();
    renderCompanies();
    toast('Company deleted');
  } catch (err) { toast(err.message, true); }
});

// ---------- import ----------

async function runImport(request, form) {
  const button = $('button', form);
  button.disabled = true;
  try {
    const { added, skipped } = await request();
    await loadCompanies();
    toast(`${added} added${skipped ? `, ${skipped} already in your list` : ''}`);
    if (added) showView('companies');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

$('#import-file').addEventListener('submit', (e) => {
  e.preventDefault();
  runImport(() => api('/api/import/file', { method: 'POST', body: new FormData(e.target) }), e.target);
});
$('#import-sheet').addEventListener('submit', (e) => {
  e.preventDefault();
  runImport(() => api('/api/import/sheet', { method: 'POST', body: formData(e.target) }), e.target);
});
$('#import-sample').addEventListener('submit', (e) => {
  e.preventDefault();
  runImport(() => api('/api/import/sample', { method: 'POST' }), e.target);
});

// ---------- start ----------

(async function init() {
  statusOptions($('#filter-status'), '', true);
  state.config = await api('/api/config');

  const error = new URLSearchParams(location.search).get('error');
  if (error) {
    history.replaceState(null, '', location.pathname);
    toast(error, true);
  }

  try {
    await enter((await api('/api/me')).user);
  } catch {
    showAuth();
  }
})();
