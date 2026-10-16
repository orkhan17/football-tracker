#!/usr/bin/env node
// Minimal static server for previewing docs/ locally (GitHub Pages serves it in production).
//
// Env:
//   PORT   optional, default 8000

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT ?? 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer(async (req, res) => {
    let file = path.join(DOCS, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(DOCS)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (file.endsWith(path.sep)) file += 'index.html';

    let body;
    try {
      body = await readFile(file);
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Dashboard: http://localhost:${PORT}  (Ctrl+C to stop)`));
