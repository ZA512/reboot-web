import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const webRoot = resolve('web');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Content-Type': contentType
  });
  response.end(body);
}

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed');
    return;
  }

  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const relativePath = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  const filePath = resolve(webRoot, relativePath);

  if (!filePath.startsWith(`${webRoot}${sep}`)) {
    send(response, 403, 'Forbidden');
    return;
  }

  try {
    if (!(await stat(filePath)).isFile()) {
      send(response, 404, 'Not found');
      return;
    }

    const contentType = mimeTypes[extname(filePath)] || 'application/octet-stream';
    if (request.method === 'HEAD') {
      send(response, 200, '', contentType);
      return;
    }
    send(response, 200, await readFile(filePath), contentType);
  } catch {
    send(response, 404, 'Not found');
  }
}).listen(port, host, () => {
  console.log(`REBOOT development server: http://${host}:${port}/`);
});