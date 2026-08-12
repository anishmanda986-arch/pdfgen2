import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const storage = process.env.STORAGE_DIR || path.join(root, 'storage');
const port = Number(process.env.PORT || 3000);
const maxBytes = 8 * 1024 * 1024;
await fs.mkdir(storage, { recursive: true });

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

async function listDocuments() {
  const files = await fs.readdir(storage);
  const docs = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const { ownerToken, ...safe } = JSON.parse(await fs.readFile(path.join(storage, file), 'utf8'));
      docs.push(safe);
    } catch {}
  }
  return docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function api(req, res, url) {
  const id = url.searchParams.get('id');
  if (req.method === 'GET' && !id) return sendJson(res, 200, { documents: await listDocuments() });
  if (req.method === 'GET' && id) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
      const pdf = await fs.readFile(pdfPath(id));
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `attachment; filename="${safeName(meta.name)}.pdf"` });
      return res.end(pdf);
    } catch { return sendJson(res, 404, { error: 'PDF not found' }); }
  }
  if (req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      if (!payload.name || !payload.ownerToken || !payload.data) return sendJson(res, 400, { error: 'Name, owner token and PDF are required' });
      const pdf = Buffer.from(payload.data, 'base64');
      if (pdf.length > maxBytes) return sendJson(res, 413, { error: 'Maximum upload size is 8 MB' });
      const id = crypto.randomUUID();
      const meta = { id, name: String(payload.name).slice(0, 140), description: String(payload.description || '').slice(0, 500), size: pdf.length, type: 'application/pdf', createdAt: new Date().toISOString(), ownerToken: payload.ownerToken };
      await fs.writeFile(pdfPath(id), pdf);
      await fs.writeFile(metaPath(id), JSON.stringify(meta));
      const { ownerToken, ...safe } = meta;
      return sendJson(res, 201, { document: safe });
    } catch { return sendJson(res, 400, { error: 'Invalid upload data' }); }
  }
  if (req.method === 'DELETE' && id) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
      if ((req.headers['x-owner-token'] || '') !== meta.ownerToken) return sendJson(res, 403, { error: 'Only the uploader can remove this PDF' });
      await Promise.all([fs.unlink(pdfPath(id)), fs.unlink(metaPath(id))]);
      return sendJson(res, 200, { ok: true });
    } catch { return sendJson(res, 404, { error: 'PDF not found' }); }
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/pdfs') return await api(req, res, url);
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, app: 'pdfgen2' });
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(root, requested));
    if (!file.startsWith(root)) return sendJson(res, 403, { error: 'Forbidden' });
    const data = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain';
    res.writeHead(200, { 'content-type': type }); res.end(data);
  } catch { sendJson(res, 404, { error: 'Not found' }); }
});
server.listen(port, '0.0.0.0', () => console.log(`pdfgen2 listening on ${port}`));
