import { getStore } from '@netlify/blobs';

const store = getStore({ name: 'pdfgen2-documents', consistency: 'strong' });
const json = (body, statusCode = 200) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body)
});

function decodeBase64(input) {
  return new Uint8Array(Buffer.from(input, 'base64'));
}

export default async function handler(event) {
  try {
    const method = event.httpMethod || 'GET';
    if (method === 'GET' && !event.queryStringParameters?.id) {
      const entries = await store.list({ prefix: 'meta:' });
      const documents = [];
      for (const item of entries.blobs || []) {
        const meta = await store.get(item.key, { type: 'json' });
        if (meta) {
          const { ownerToken, ...safe } = meta;
          documents.push(safe);
        }
      }
      documents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return json({ documents });
    }

    if (method === 'GET' && event.queryStringParameters?.id) {
      const id = event.queryStringParameters.id;
      const meta = await store.get(`meta:${id}`, { type: 'json' });
      if (!meta) return json({ error: 'PDF not found' }, 404);
      const bytes = await store.get(id, { type: 'arrayBuffer' });
      if (!bytes) return json({ error: 'PDF not found' }, 404);
      const filename = (meta.name || 'document').replace(/[^a-z0-9._-]/gi, '_');
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${filename}.pdf"`,
          'cache-control': 'no-store'
        },
        body: Buffer.from(bytes).toString('base64')
      };
    }

    if (method === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const { name, description = '', ownerToken, data, size, type } = payload;
      if (!name || !ownerToken || !data) return json({ error: 'Name, owner token and PDF are required' }, 400);
      const bytes = decodeBase64(data);
      if (bytes.byteLength > 8 * 1024 * 1024) return json({ error: 'Maximum file size is 8 MB' }, 413);
      const id = crypto.randomUUID();
      const meta = {
        id,
        name: String(name).slice(0, 140),
        description: String(description).slice(0, 500),
        size: Number(size) || bytes.byteLength,
        type: type || 'application/pdf',
        createdAt: new Date().toISOString(),
        ownerToken
      };
      await store.set(id, bytes, { metadata: { contentType: 'application/pdf', name: meta.name } });
      await store.setJSON(`meta:${id}`, meta);
      const { ownerToken: _, ...safe } = meta;
      return json({ document: safe }, 201);
    }

    if (method === 'DELETE') {
      const id = event.queryStringParameters?.id;
      const ownerToken = event.headers?.['x-owner-token'] || event.headers?.['X-Owner-Token'];
      if (!id || !ownerToken) return json({ error: 'Missing document or owner token' }, 400);
      const meta = await store.get(`meta:${id}`, { type: 'json' });
      if (!meta) return json({ error: 'PDF not found' }, 404);
      if (meta.ownerToken !== ownerToken) return json({ error: 'Only the uploader can remove this PDF' }, 403);
      await store.delete(id);
      await store.delete(`meta:${id}`);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error(error);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
