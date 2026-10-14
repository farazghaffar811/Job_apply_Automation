const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SEED_COMPANIES = require('./data/seed-companies.json');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env is optional */ }

const ON_VERCEL = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT) || 4310;
const BASE_URL = (process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || `http://localhost:${PORT}`).replace(/\/$/, '');
const LINKEDIN_ID = process.env.LINKEDIN_CLIENT_ID || '';
const LINKEDIN_SECRET = process.env.LINKEDIN_CLIENT_SECRET || '';
const LINKEDIN_REDIRECT = `${BASE_URL}/auth/linkedin/callback`;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Vercel rejects request bodies over 4.5 MB, so uploads have to stay under that there.
const MAX_UPLOAD_MB = ON_VERCEL ? 4 : 8;
const STORAGE_HELP = 'Storage is not set up. In your Vercel project open Storage, add "Upstash for Redis", connect it to this project, then redeploy.';

const STATUSES = ['todo', 'in_progress', 'review', 'applied', 'no_opening', 'manual', 'skipped'];
const PROFILE_FIELDS = ['fullName', 'email', 'phone', 'city', 'targetRoles', 'experienceYears', 'linkedinUrl',
  'portfolioUrl', 'githubUrl', 'expectedSalary', 'noticePeriod', 'workMode', 'coverNote'];
const COMPANY_FIELDS = ['name', 'type', 'size', 'location', 'website', 'linkedin', 'careersUrl', 'role', 'notes'];
const URL_FIELDS = ['website', 'linkedin', 'careersUrl'];
const RESUME_TYPES = ['.pdf', '.doc', '.docx'];

// ---------- storage ----------
// Locally everything lives in data/db.json and uploads/. Serverless hosts such as Vercel have a
// read-only filesystem that is wiped between invocations, so there the data goes to Upstash Redis.

function fileStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let cache = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : null;
  const dirFor = (userId) => path.join(UPLOAD_DIR, userId);
  return {
    kind: 'file',
    async load() { return cache; },
    async save(data) {
      cache = data;
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DB_FILE);
    },
    async putResume(userId, file, buffer) {
      fs.rmSync(dirFor(userId), { recursive: true, force: true });
      fs.mkdirSync(dirFor(userId), { recursive: true });
      fs.writeFileSync(path.join(dirFor(userId), file), buffer);
    },
    async getResume(userId, file) {
      const p = path.join(dirFor(userId), file);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    },
    async deleteResume(userId) { fs.rmSync(dirFor(userId), { recursive: true, force: true }); },
    resumePath: (userId, file) => path.join(dirFor(userId), file),
  };
}

function redisStore(url, token) {
  const KEY = 'job-apply-hub:db';
  const resumeKey = (userId) => `${KEY}:resume:${userId}`;
  async function call(...command) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(`Redis ${command[0]} failed: ${out.error || res.status}`);
    return out.result;
  }
  return {
    kind: 'redis',
    async load() {
      const raw = await call('GET', KEY);
      return raw ? JSON.parse(raw) : null;
    },
    async save(data) { await call('SET', KEY, JSON.stringify(data)); },
    async putResume(userId, file, buffer) { await call('SET', resumeKey(userId), buffer.toString('base64')); },
    async getResume(userId) {
      const raw = await call('GET', resumeKey(userId));
      return raw ? Buffer.from(raw, 'base64') : null;
    },
    async deleteResume(userId) { await call('DEL', resumeKey(userId)); },
    resumePath: () => '',
  };
}

const store = REDIS_URL && REDIS_TOKEN ? redisStore(REDIS_URL, REDIS_TOKEN) : ON_VERCEL ? null : fileStore();

// Reloaded at the start of every request so serverless instances always see the latest data.
let db;

async function loadDb() {
  db = await store.load();
  if (!db) {
    db = { secret: crypto.randomBytes(32).toString('hex'), users: [], companies: [] };
    await store.save(db);
  }
}

const save = () => store.save(db);

// ---------- helpers ----------

const newId = () => crypto.randomBytes(8).toString('hex');
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const hmac = (v) => crypto.createHmac('sha256', db.secret).update(v).digest('hex');
const sign = (v) => `${v}.${hmac(v)}`;

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function unsign(signed) {
  const i = String(signed || '').lastIndexOf('.');
  if (i < 1) return null;
  const v = signed.slice(0, i);
  return safeEq(signed.slice(i + 1), hmac(v)) ? v : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieOptions = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https:'), maxAge });

function httpUrl(v) {
  const s = clean(v, 600);
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

function startSession(res, user) {
  res.cookie('sid', sign(`${user.id}.${Date.now() + WEEK_MS}`), cookieOptions(WEEK_MS));
}

function sessionUser(req) {
  const raw = unsign(cookies(req).sid);
  if (!raw) return null;
  const [id, expires] = raw.split('.');
  if (Number(expires) < Date.now()) return null;
  return db.users.find((u) => u.id === id) || null;
}

function createUser({ email, name }) {
  const user = {
    id: newId(), email, name, picture: '', linkedinSub: '', passHash: '', salt: '',
    apiToken: crypto.randomBytes(24).toString('hex'),
    profile: { fullName: name, email },
    resume: null,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  return user;
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, picture: u.picture,
    linkedinLinked: Boolean(u.linkedinSub), hasPassword: Boolean(u.passHash),
    profile: u.profile, apiToken: u.apiToken,
    resume: u.resume && { name: u.resume.name, uploadedAt: u.resume.uploadedAt, path: store.resumePath(u.id, u.resume.file) },
  };
}

function companyFrom(input, base = {}) {
  const c = { ...base };
  for (const f of COMPANY_FIELDS) {
    if (input[f] === undefined) continue;
    c[f] = URL_FIELDS.includes(f) ? httpUrl(input[f]) : clean(input[f], f === 'notes' ? 4000 : 300);
  }
  if (input.status !== undefined && STATUSES.includes(input.status)) {
    if (input.status === 'applied' && c.status !== 'applied') c.appliedAt = new Date().toISOString();
    if (input.status !== 'applied') c.appliedAt = '';
    c.status = input.status;
  }
  c.updatedAt = new Date().toISOString();
  return c;
}

// ---------- spreadsheet import ----------

function mapColumns(header) {
  const idx = {};
  header.forEach((h, i) => {
    const k = String(h).trim().toLowerCase();
    if (/^(company\s*)?name$|^company$|^organi[sz]ation$/.test(k)) idx.name ??= i;
    else if (/type|category|model/.test(k)) idx.type ??= i;
    else if (/size|employees|headcount/.test(k)) idx.size ??= i;
    else if (/location|city|address|area/.test(k)) idx.location ??= i;
    else if (/career|jobs|apply/.test(k)) idx.careersUrl ??= i;
    else if (/linkedin/.test(k)) idx.linkedin ??= i;
    else if (/website|url|site|web/.test(k)) idx.website ??= i;
    else if (/role|position|title/.test(k)) idx.role ??= i;
    else if (/note|comment|remark/.test(k)) idx.notes ??= i;
  });
  idx.name ??= 0;
  // An unlabelled column right after the name is the company type in the ISB sheet layout.
  if (idx.type === undefined && header.length > 1 && !String(header[1]).trim() && idx.name === 0) idx.type = 1;
  return idx;
}

function rowsFromWorkbook(wb) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerAt = rows.findIndex((r) => r.some((c) => String(c).trim()));
  if (headerAt < 0) return [];
  const idx = mapColumns(rows[headerAt]);
  return rows.slice(headerAt + 1)
    .map((r) => Object.fromEntries(Object.entries(idx).map(([field, i]) => [field, r[i]])))
    .filter((r) => clean(r.name));
}

async function importRows(user, rows) {
  const existing = new Set(db.companies.filter((c) => c.userId === user.id).map((c) => c.name.toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    const name = clean(row.name, 300);
    if (!name || existing.has(name.toLowerCase())) { skipped += 1; continue; }
    existing.add(name.toLowerCase());
    db.companies.push(companyFrom(row, {
      id: newId(), userId: user.id, name, type: '', size: '', location: '', website: '', linkedin: '',
      careersUrl: '', role: '', notes: '', status: 'todo', appliedAt: '', createdAt: new Date().toISOString(),
    }));
    added += 1;
  }
  await save();
  return { added, skipped };
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => { req.body ??= {}; next(); });
// On Vercel the public/ folder is served by the CDN; this covers local runs.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    linkedin: Boolean(LINKEDIN_ID && LINKEDIN_SECRET), linkedinRedirect: LINKEDIN_REDIRECT, statuses: STATUSES,
    storage: store ? store.kind : null, storageError: store ? '' : STORAGE_HELP, maxUploadMb: MAX_UPLOAD_MB,
  });
});

app.use(['/api', '/auth'], async (req, res, next) => {
  if (!store) {
    return req.baseUrl === '/auth' ? res.redirect('/?error=' + encodeURIComponent(STORAGE_HELP)) : res.status(503).json({ error: STORAGE_HELP });
  }
  await loadDb();
  next();
});

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const user = header.startsWith('Bearer ')
    ? db.users.find((u) => safeEq(u.apiToken, header.slice(7).trim()))
    : sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

// ---------- email sign-in ----------

app.post('/api/register', async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const name = clean(req.body.name, 120) || email.split('@')[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  let user = db.users.find((u) => u.email === email);
  if (user && user.passHash) return res.status(409).json({ error: 'An account with this email already exists' });
  // A LinkedIn-only account can only gain a password from inside its own session.
  if (user && sessionUser(req)?.id !== user.id) return res.status(409).json({ error: 'This email is linked to LinkedIn sign-in. Sign in with LinkedIn first.' });
  if (!user) user = createUser({ email, name });
  const { salt, hash } = hashPassword(password);
  user.salt = salt;
  user.passHash = hash;
  await save();
  startSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const user = db.users.find((u) => u.email === email);
  const ok = user && user.passHash && safeEq(hashPassword(String(req.body.password || ''), user.salt).hash, user.passHash);
  if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
  startSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('sid', cookieOptions());
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- LinkedIn sign-in (OpenID Connect) ----------

app.get('/auth/linkedin', (req, res) => {
  if (!LINKEDIN_ID || !LINKEDIN_SECRET) return res.redirect('/?error=' + encodeURIComponent('LinkedIn sign-in is not configured yet'));
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('li_state', sign(state), cookieOptions(10 * 60 * 1000));
  const params = new URLSearchParams({
    response_type: 'code', client_id: LINKEDIN_ID, redirect_uri: LINKEDIN_REDIRECT, state, scope: 'openid profile email',
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/?error=' + encodeURIComponent(msg));
  try {
    const expected = unsign(cookies(req).li_state);
    res.clearCookie('li_state', cookieOptions());
    if (req.query.error) return fail('LinkedIn sign-in was cancelled');
    if (!expected || !safeEq(expected, req.query.state || '')) return fail('LinkedIn sign-in expired, please try again');

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: LINKEDIN_REDIRECT,
        client_id: LINKEDIN_ID, client_secret: LINKEDIN_SECRET,
      }),
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) return fail('LinkedIn rejected the sign-in. Check the client ID, secret and redirect URL.');

    const infoRes = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.sub) return fail('Could not read your LinkedIn profile');

    const email = clean(info.email, 200).toLowerCase();
    const current = sessionUser(req);
    const owner = db.users.find((u) => u.linkedinSub === info.sub);
    if (current && owner && owner.id !== current.id) return fail('That LinkedIn account is already linked to another login');

    let user = current || owner;
    // Only trust the email match when LinkedIn says the address is verified.
    if (!user && email && info.email_verified) user = db.users.find((u) => u.email === email);
    if (!user) {
      if (!email) return fail('LinkedIn did not share an email address');
      if (db.users.some((u) => u.email === email)) return fail('Sign in with your email first, then link LinkedIn from Profile');
      user = createUser({ email, name: clean(info.name, 120) || email.split('@')[0] });
    }
    user.linkedinSub = info.sub;
    user.picture = httpUrl(info.picture);
    if (!user.name) user.name = clean(info.name, 120);
    user.profile.fullName ||= clean(info.name, 120);
    await save();
    startSession(res, user);
    res.redirect('/');
  } catch (err) {
    console.error('LinkedIn callback failed:', err);
    fail('LinkedIn sign-in failed, please try again');
  }
});

// ---------- profile + resume ----------

app.put('/api/profile', auth, async (req, res) => {
  for (const f of PROFILE_FIELDS) {
    if (req.body[f] !== undefined) req.user.profile[f] = clean(req.body[f], f === 'coverNote' ? 4000 : 300);
  }
  await save();
  res.json({ user: publicUser(req.user) });
});

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

app.post('/api/resume', auth, memoryUpload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!RESUME_TYPES.includes(ext)) return res.status(400).json({ error: 'Resume must be a PDF, DOC or DOCX file' });
  const file = `resume${ext}`;
  await store.putResume(req.user.id, file, req.file.buffer);
  req.user.resume = { file, name: clean(path.basename(req.file.originalname), 200), uploadedAt: new Date().toISOString() };
  await save();
  res.json({ user: publicUser(req.user) });
});

app.get('/api/resume', auth, async (req, res) => {
  const buffer = req.user.resume && await store.getResume(req.user.id, req.user.resume.file);
  if (!buffer) return res.status(404).json({ error: 'No resume uploaded yet' });
  res.attachment(req.user.resume.name);
  res.send(buffer);
});

app.delete('/api/resume', auth, async (req, res) => {
  await store.deleteResume(req.user.id);
  req.user.resume = null;
  await save();
  res.json({ user: publicUser(req.user) });
});

app.post('/api/token/rotate', auth, async (req, res) => {
  req.user.apiToken = crypto.randomBytes(24).toString('hex');
  await save();
  res.json({ user: publicUser(req.user) });
});

// ---------- companies ----------

const mine = (req) => db.companies.filter((c) => c.userId === req.user.id);

app.get('/api/companies', auth, (req, res) => {
  const status = req.query.status;
  res.json({ companies: status ? mine(req).filter((c) => c.status === status) : mine(req) });
});

app.post('/api/companies', auth, async (req, res) => {
  const name = clean(req.body.name, 300);
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  const company = companyFrom(req.body, {
    id: newId(), userId: req.user.id, name, type: '', size: '', location: '', website: '', linkedin: '',
    careersUrl: '', role: '', notes: '', status: 'todo', appliedAt: '', createdAt: new Date().toISOString(),
  });
  db.companies.push(company);
  await save();
  res.json({ company });
});

app.patch('/api/companies/:id', auth, async (req, res) => {
  const i = db.companies.findIndex((c) => c.id === req.params.id && c.userId === req.user.id);
  if (i < 0) return res.status(404).json({ error: 'Company not found' });
  if (req.body.name !== undefined && !clean(req.body.name)) return res.status(400).json({ error: 'Company name is required' });
  if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
  db.companies[i] = companyFrom(req.body, db.companies[i]);
  await save();
  res.json({ company: db.companies[i] });
});

app.delete('/api/companies/:id', auth, async (req, res) => {
  const before = db.companies.length;
  db.companies = db.companies.filter((c) => !(c.id === req.params.id && c.userId === req.user.id));
  if (db.companies.length === before) return res.status(404).json({ error: 'Company not found' });
  await save();
  res.json({ ok: true });
});

// ---------- import ----------

app.post('/api/import/file', auth, memoryUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a spreadsheet to upload' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) return res.status(400).json({ error: 'Upload an .xlsx, .xls or .csv file' });
  let rows;
  try { rows = rowsFromWorkbook(XLSX.read(req.file.buffer, { type: 'buffer' })); }
  catch { return res.status(400).json({ error: 'Could not read that spreadsheet' }); }
  if (!rows.length) return res.status(400).json({ error: 'No companies found. The first column should hold company names.' });
  res.json(await importRows(req.user, rows));
});

app.post('/api/import/sheet', auth, async (req, res) => {
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})/.exec(clean(req.body.url, 600));
  if (!match) return res.status(400).json({ error: 'Paste a Google Sheets link (docs.google.com/spreadsheets/d/...)' });
  const gid = (/[#?&]gid=(\d+)/.exec(req.body.url) || [])[1] || '0';
  let text;
  try {
    const sheetRes = await fetch(`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`);
    const type = sheetRes.headers.get('content-type') || '';
    if (!sheetRes.ok || !type.includes('csv')) {
      return res.status(400).json({ error: 'That sheet is private. Set sharing to "Anyone with the link", or download it as .xlsx and upload the file.' });
    }
    text = await sheetRes.text();
  } catch {
    return res.status(502).json({ error: 'Could not reach Google Sheets. Check your connection and try again.' });
  }
  const rows = rowsFromWorkbook(XLSX.read(text, { type: 'string' }));
  if (!rows.length) return res.status(400).json({ error: 'No companies found in that sheet' });
  res.json(await importRows(req.user, rows));
});

app.post('/api/import/sample', auth, async (req, res) => {
  const rows = SEED_COMPANIES.map(([name, type, size, location, website, linkedin]) => ({ name, type, size, location, website, linkedin }));
  res.json(await importRows(req.user, rows));
});

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File is too large (${MAX_UPLOAD_MB} MB max)` : 'Upload failed' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (!ON_VERCEL) app.listen(PORT, '127.0.0.1', () => console.log(`Job Apply Hub running at ${BASE_URL} (storage: ${store.kind})`));

module.exports = app;
