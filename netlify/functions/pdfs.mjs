const apiOrigin = 'https://pdfgen2.up.railway.app';

export const handler = async (event) => {
  const incoming = new URL(event.rawUrl || `https://netlify.local${event.path || ''}`);
  const route = incoming.pathname.startsWith('/api/') ? incoming.pathname : '/api/pdfs';
  const target = new URL(apiOrigin + route);
  for (const [key, value] of incoming.searchParams) target.searchParams.set(key, value);
  const headers = {};
  if (event.headers?.['content-type']) headers['content-type'] = event.headers['content-type'];
  if (event.headers?.['x-owner-token']) headers['x-owner-token'] = event.headers['x-owner-token'];
  const response = await fetch(target, {
    method: event.httpMethod || 'GET',
    headers,
    body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : (event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body)
  });
  const contentType = response.headers.get('content-type') || 'application/json';
  const data = Buffer.from(await response.arrayBuffer());
  if (contentType.includes('application/pdf')) return { statusCode: response.status, isBase64Encoded: true, headers: { 'content-type': contentType, 'content-disposition': response.headers.get('content-disposition') || 'attachment' }, body: data.toString('base64') };
  return { statusCode: response.status, headers: { 'content-type': contentType, 'cache-control': 'no-store' }, body: data.toString('utf8') };
};
