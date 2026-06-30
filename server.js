import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'app.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const env = readEnv();
const PORT = Number(env.PORT || 3000);
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessions = new Map();

function readEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx >= 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { photos: [], codes: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { photos: [], codes: [] }; }
}

async function saveDb(db) {
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    if (!part.trim()) continue;
    const bits = part.trim().split('=');
    const key = bits.shift();
    result[key] = decodeURIComponent(bits.join('='));
  }
  return result;
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  let id = cookies.sid;
  if (!id || !sessions.has(id)) {
    id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, { admin: false, lastCodes: [] });
    res.setHeader('Set-Cookie', 'sid=' + id + '; HttpOnly; SameSite=Lax; Path=/');
  }
  return sessions.get(id);
}

function isAdmin(req) {
  const cookies = parseCookies(req);
  return Boolean(cookies.sid && sessions.get(cookies.sid) && sessions.get(cookies.sid).admin);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  redirect(res, '/admin');
  return false;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase() + SESSION_SECRET).digest('hex');
}

function makeCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function readBody(req, limit) {
  limit = limit || 600 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Zu grosse Anfrage'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseUrlEncoded(req) {
  const body = (await readBody(req, 1024 * 1024)).toString('utf8');
  return Object.fromEntries(new URLSearchParams(body));
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };
  const boundary = Buffer.from('--' + (match[1] || match[2]));
  const fields = {};
  const files = [];
  let position = 0;
  while (true) {
    const start = buffer.indexOf(boundary, position);
    if (start < 0) break;
    let partStart = start + boundary.length;
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    if (buffer.slice(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0) break;
    const headers = buffer.slice(partStart, headerEnd).toString('latin1');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const content = buffer.slice(headerEnd + 4, next - 2);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const mimeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : '';
    const filename = fileMatch ? fileMatch[1] : '';
    const mime = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
    if (filename) files.push({ field: name, filename: path.basename(filename), mime: mime, content: content });
    else if (name) fields[name] = content.toString('utf8');
    position = next;
  }
  return { fields: fields, files: files };
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({ length: 256 }, function(_, n) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  date = date || new Date();
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

async function makeZip(photos) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const photo of photos) {
    const filePath = path.join(UPLOAD_DIR, photo.storedName);
    if (!fs.existsSync(filePath)) continue;
    const data = await fsp.readFile(filePath);
    const name = Buffer.from(photo.originalName.replace(/[\\/:*?"<>|]/g, '_'));
    const crc = crc32(data);
    const dt = dosDateTime(new Date(photo.uploadedAt));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dt.time, 12);
    header.writeUInt16LE(dt.day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const count = central.length / 2;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat(chunks.concat(central).concat([end]));
}

async function serveStatic(res, fileName) {
  const safe = path.basename(fileName);
  const full = path.join(PUBLIC_DIR, safe);
  if (!fs.existsSync(full)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  const ext = path.extname(full).toLowerCase();
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml; charset=utf-8'
  };
  send(res, 200, await fsp.readFile(full), types[ext] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const session = getSession(req, res);
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && url.pathname === '/style.css') return serveStatic(res, 'style.css');
    if (req.method === 'GET' && /^\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));

    if (req.method === 'POST' && url.pathname === '/download') {
      const form = await parseUrlEncoded(req);
      const db = loadDb();
      const code = String(form.code || '').trim().toUpperCase();
      const record = db.codes.find(c => c.hash === hashCode(code));
      if (!record) return redirect(res, '/?error=' + encodeURIComponent('Dieser Code ist unbekannt.'));
      if (record.usedAt) return redirect(res, '/?error=' + encodeURIComponent('Dieser Code wurde bereits benutzt.'));
      const photos = db.photos.filter(p => fs.existsSync(path.join(UPLOAD_DIR, p.storedName)));
      if (!photos.length) return redirect(res, '/?error=' + encodeURIComponent('Es sind noch keine Bilder vorhanden.'));
      record.usedAt = new Date().toISOString();
      record.usedIp = req.socket.remoteAddress || '';
      await saveDb(db);
      const zip = await makeZip(photos);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="zeltlager-bilder.zip"', 'Content-Length': zip.length });
      return res.end(zip);
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      if (isAdmin(req)) return redirect(res, '/admin/dashboard');
      return serveStatic(res, 'login.html');
    }
    if (req.method === 'POST' && url.pathname === '/admin/login') {
      const form = await parseUrlEncoded(req);
      if (String(form.password || '') === ADMIN_PASSWORD) {
        session.admin = true;
        return redirect(res, '/admin/dashboard');
      }
      return redirect(res, '/admin?error=' + encodeURIComponent('Falsches Passwort.'));
    }
    if (req.method === 'POST' && url.pathname === '/admin/logout') {
      session.admin = false;
      return redirect(res, '/');
    }
    if (req.method === 'GET' && url.pathname === '/admin/dashboard') {
      if (!requireAdmin(req, res)) return;
      return serveStatic(res, 'admin.html');
    }
    if (req.method === 'GET' && url.pathname === '/admin/state') {
      if (!requireAdmin(req, res)) return;
      const db = loadDb();
      return send(res, 200, JSON.stringify({ photos: db.photos, codes: db.codes.map(({ hash, ...rest }) => rest) }), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/admin/last-codes') {
      if (!requireAdmin(req, res)) return;
      const codes = session.lastCodes || [];
      session.lastCodes = [];
      return send(res, 200, JSON.stringify({ codes: codes }), 'application/json; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/admin/photos') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const parsed = parseMultipart(body, req.headers['content-type']);
      const db = loadDb();
      for (const file of parsed.files.filter(f => f.field === 'photos' && f.filename && f.content.length)) {
        if (!/^image\//i.test(file.mime)) continue;
        const id = crypto.randomUUID();
        const ext = path.extname(file.filename).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
        const storedName = id + ext;
        await fsp.writeFile(path.join(UPLOAD_DIR, storedName), file.content);
        db.photos.push({ id: id, originalName: file.filename, storedName: storedName, size: file.content.length, mime: file.mime, uploadedAt: new Date().toISOString() });
      }
      await saveDb(db);
      return redirect(res, '/admin/dashboard');
    }
    const photoDelete = /^\/admin\/photos\/([^/]+)\/delete$/.exec(url.pathname);
    if (req.method === 'POST' && photoDelete) {
      if (!requireAdmin(req, res)) return;
      const db = loadDb();
      const photo = db.photos.find(p => p.id === photoDelete[1]);
      if (photo) await fsp.rm(path.join(UPLOAD_DIR, photo.storedName), { force: true });
      db.photos = db.photos.filter(p => p.id !== photoDelete[1]);
      await saveDb(db);
      return redirect(res, '/admin/dashboard');
    }
    if (req.method === 'POST' && url.pathname === '/admin/codes') {
      if (!requireAdmin(req, res)) return;
      const form = await parseUrlEncoded(req);
      const amount = Math.max(1, Math.min(200, Number(form.amount || 1)));
      const label = String(form.label || '').trim();
      const db = loadDb();
      const created = [];
      while (created.length < amount) {
        const code = makeCode();
        const hash = hashCode(code);
        if (db.codes.some(c => c.hash === hash)) continue;
        db.codes.push({ id: crypto.randomUUID(), hash: hash, label: label, createdAt: new Date().toISOString(), usedAt: null, usedIp: null });
        created.push(code);
      }
      session.lastCodes = created;
      await saveDb(db);
      return redirect(res, '/admin/dashboard');
    }
    const codeDelete = /^\/admin\/codes\/([^/]+)\/delete$/.exec(url.pathname);
    if (req.method === 'POST' && codeDelete) {
      if (!requireAdmin(req, res)) return;
      const db = loadDb();
      db.codes = db.codes.filter(c => c.id !== codeDelete[1] || c.usedAt);
      await saveDb(db);
      return redirect(res, '/admin/dashboard');
    }
    send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  } catch (error) {
    console.error(error);
    send(res, 500, 'Interner Fehler: ' + error.message, 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, () => {
  console.log('Zeltlager-Website laeuft auf http://localhost:' + PORT);
  console.log('Adminbereich: http://localhost:' + PORT + '/admin');
  console.log('Standard-Passwort ohne .env: admin');
});
