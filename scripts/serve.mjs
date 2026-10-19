import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv.find(argument => argument.startsWith('--port='))?.split('=')[1] || 8080);
const apiPort = Number(process.env.API_PORT || 3000);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
};

http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Start the local backend API before using portal features.' }));
    });
    request.pipe(upstream);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/home.html' : url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname.split(/[\\/]/).includes('..')) {
    response.writeHead(403).end();
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  const publicPath = /^\/[a-z-]+\.html$/.test(pathname)
    || ['/styles.css', '/portal-shared.js', '/load-components.js', '/projects.json'].includes(pathname)
    || /^\/(?:css|js|images|fonts|invoice_template)\//.test(pathname);
  if (!publicPath || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Frontend: http://127.0.0.1:${port} (API proxy: 127.0.0.1:${apiPort})`));