import { createServer } from 'node:http';

createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url.startsWith('/api/oauth/google/status')) {
    response.end(JSON.stringify({ connected: false, provider: null, scopes: [], csrf_token: null }));
    return;
  }
  if (request.url.startsWith('/api/sync/lease')) {
    if (request.method === 'DELETE') { response.statusCode = 204; response.end(); return; }
    response.end(JSON.stringify({ status: 'acquired', leaseId: '22222222-2222-4222-8222-222222222222', expiresAt: new Date(Date.now() + 15000).toISOString() }));
    return;
  }
  response.statusCode = 503;
  response.end(JSON.stringify({ error: 'broker_test_stub', category: 'temporary' }));
}).listen(3000, '0.0.0.0');
