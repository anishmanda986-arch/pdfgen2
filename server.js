import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const storage = process.env.STORAGE_DIR || path.join(root, 'storage');
const chunks = path.join(storage, '.chunks');
const port = Number(process.env.PORT || 3000);
const maxBytes = 50 * 1024 * 1024;
const expiryMs = 12 * 60 * 60 * 1000;
await fs.mkdir(chunks, { recursive: true });

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const safeName = name => String(name || 'document').replace(/[^a-z0-9._-]/gi, '_').slice(0, 140);
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > maxBytes * 2) req.destroy(); });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});
const metaPath = id => path.join(storage, `${id}.json`);
const pdfPath = id => path.join(storage, `${id}.pdf`);
const chunkPath = (uploadId, index) => path.join(chunks, `${uploadId}.${index}`);
const safeUploadId = id => /^[a-zA-Z0-9-]{8,80}$/.test(String(id || ''));

async function removeDocument(id) {
  await Promise.all([fs.unlink(pdfPath(id)).catch(() => {}), fs.unlink(metaPath(id)).catch(() => {})]);
}
async function cleanupExpired() {
  const files = await fs.readdir(storage);
  const now = Date.now();
  await Promise.all(files.filter(f => f.endsWith('.json')).map(async file => {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(storage, file), 'utf8'));
      if (meta.createdAt && now - new Date(meta.createdAt).getTime() >= expiryMs) await removeDocument(meta.id);
    } catch {}
  }));
}
async function listDocuments(ownerToken) {
  await cleanupExpired();
  if (!ownerToken) return [];
  const files = await fs.readdir(storage);
  const docs = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(storage, file), 'utf8'));
      if (meta.ownerToken !== ownerToken) continue;
      const { ownerToken: hidden, ...safe } = meta;
      docs.push(safe);
    } catch {}
  }
  return docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveDocument(pdf, payload) {
  if (!payload.name || !payload.ownerToken) throw new Error('Name and owner token are required');
  if (pdf.length > maxBytes) throw new Error('Maximum upload size is 50 MB');
  const id = crypto.randomUUID();
  const meta = { id, name: String(payload.name).slice(0, 140), description: String(payload.description || '').slice(0, 500), size: pdf.length, type: 'application/pdf', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiryMs).toISOString(), ownerToken: String(payload.ownerToken) };
  await fs.writeFile(pdfPath(id), pdf);
  await fs.writeFile(metaPath(id), JSON.stringify(meta));
  const { ownerToken, ...safe } = meta;
  return safe;
}

async function completeChunkedUpload(payload) {
  const { uploadId, total, name, description, ownerToken, size } = payload;
  if (!safeUploadId(uploadId) || !Number.isInteger(total) || total < 1 || total > 40 || !name || !ownerToken) throw new Error('Invalid upload session');
  const buffers = [];
  try {
    for (let i = 0; i < total; i++) buffers.push(await fs.readFile(chunkPath(uploadId, i)));
    const pdf = Buffer.concat(buffers);
    if (Number(size) && pdf.length !== Number(size)) throw new Error('Upload size check failed');
    return await saveDocument(pdf, { name, description, ownerToken });
  } finally { await Promise.all(Array.from({ length: total }, (_, i) => fs.unlink(chunkPath(uploadId, i)).catch(() => {}))); }
}

async function api(req, res, url) {
  const id = url.searchParams.get('id');
  const ownerToken = String(req.headers['x-owner-token'] || '');
  if (req.method === 'GET' && !id) return sendJson(res, 200, { documents: await listDocuments(ownerToken) });
  if (req.method === 'GET' && id) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
      if (!ownerToken || ownerToken !== meta.ownerToken) return sendJson(res, 404, { error: 'PDF not found in your private bookshelf' });
      const pdf = await fs.readFile(pdfPath(id));
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `inline; filename="${safeName(meta.name)}.pdf"` });
      return res.end(pdf);
    } catch { return sendJson(res, 404, { error: 'PDF not found' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/pdfs/chunk') {
    try {
      const payload = JSON.parse(await readBody(req));
      if (!safeUploadId(payload.uploadId) || !Number.isInteger(payload.index) || !Number.isInteger(payload.total) || payload.index < 0 || payload.index >= payload.total || !payload.data) return sendJson(res, 400, { error: 'Invalid upload chunk' });
      const bytes = Buffer.from(payload.data, 'base64');
      if (bytes.length > 4 * 1024 * 1024) return sendJson(res, 413, { error: 'Chunk is too large' });
      await fs.writeFile(chunkPath(payload.uploadId, payload.index), bytes);
      return sendJson(res, 200, { ok: true, index: payload.index });
    } catch { return sendJson(res, 400, { error: 'Could not save upload chunk' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/pdfs/complete') {
    try { return sendJson(res, 201, { document: await completeChunkedUpload(JSON.parse(await readBody(req))) }); }
    catch (error) { return sendJson(res, 400, { error: error.message || 'Could not complete upload' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/pdfs') {
    try {
      const payload = JSON.parse(await readBody(req));
      if (!payload.name || !payload.ownerToken || !payload.data) return sendJson(res, 400, { error: 'Name, owner token and PDF are required' });
      return sendJson(res, 201, { document: await saveDocument(Buffer.from(payload.data, 'base64'), payload) });
    } catch (error) { return sendJson(res, error.message?.includes('50 MB') ? 413 : 400, { error: error.message || 'Invalid upload data' }); }
  }
  if (req.method === 'DELETE' && id) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
      if (!ownerToken || ownerToken !== meta.ownerToken) return sendJson(res, 403, { error: 'Only the uploader can remove this PDF' });
      await removeDocument(id);
      return sendJson(res, 200, { ok: true });
    } catch { return sendJson(res, 404, { error: 'PDF not found' }); }
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/pdfs')) return await api(req, res, url);
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, app: 'pdfgen2' });
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(root, requested));
    if (!file.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' });
    const data = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain';
    res.writeHead(200, { 'content-type': type }); res.end(data);
  } catch { sendJson(res, 404, { error: 'Not found' }); }
});
await cleanupExpired();
setInterval(() => cleanupExpired().catch(() => {}), 10 * 60 * 1000);
server.listen(port, '0.0.0.0', () => console.log(`pdfgen2 listening on ${port}`));
