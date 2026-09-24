#!/usr/bin/env node
// tools/e2e/serve.cjs : serve web/ the way Vercel serves it (docs/game-spec.md 12.5 and 13.8). Owner: P7.
//
//   node tools/e2e/serve.cjs [--port 4173] [--root web]      prints the URL, serves until killed
//   const { serve } = require('./serve.cjs'); const s = await serve({ port: 0 }); s.url; await s.close();
//
// Read from web/vercel.json: cleanUrls (/film serves film.html, /film.html redirects 308 to /film,
// /index.html to /), trailingSlash false (/film/ redirects 308 to /film), and every headers rule
// (the source is a path-to-regexp pattern; the ones the site uses are plain regex groups).
// Only GET and HEAD; anything outside web/ or a dotfile is 404. Every request is logged in s.log.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// path-to-regexp subset: literal text, (regex groups), :named params, and (.*) wildcards
function sourceRe(src) {
  let re = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '(') {
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      re += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === ':') {
      const m = /^:([A-Za-z0-9_]+)/.exec(src.slice(i));
      re += '([^/]+)';
      i += m[0].length;
    } else {
      re += c.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function loadConfig(root) {
  const f = path.join(root, 'vercel.json');
  const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const rules = (cfg.headers || []).map((r) => ({ re: sourceRe(r.source), headers: r.headers }));
  return { cfg, rules };
}

function serve({ port = 4173, root = path.join(ROOT, 'web'), host = '127.0.0.1' } = {}) {
  root = path.resolve(root);
  const log = [];
  const server = http.createServer((req, res) => {
    const { cfg, rules } = loadConfig(root); // re-read: site.cjs may rewrite it between runs
    const u = new URL(req.url, 'http://x');
    let p;
    try {
      p = decodeURIComponent(u.pathname);
    } catch (e) {
      p = '/\0';
    }
    log.push({ method: req.method, path: u.pathname });
    const headers = {};
    for (const r of rules) if (r.re.test(p)) for (const h of r.headers) headers[h.key] = h.value;
    const send = (status, body, extra = {}) => {
      res.writeHead(status, Object.assign({}, headers, extra));
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', { Allow: 'GET, HEAD' });
    const redirect = (to) => send(308, '', { Location: to + u.search });
    if (cfg.trailingSlash === false && p.length > 1 && p.endsWith('/')) return redirect(p.replace(/\/+$/, ''));
    if (cfg.cleanUrls) {
      if (p === '/index.html' || p === '/index') return redirect('/');
      if (p.endsWith('.html')) return redirect(p.slice(0, -5));
    }
    let file = p === '/' ? '/index.html' : p;
    if (cfg.cleanUrls && !path.extname(file)) file += '.html';
    const abs = path.join(root, file);
    const inside = abs.startsWith(root + path.sep) && !file.split('/').some((s) => s.startsWith('.'));
    if (!inside || !fs.existsSync(abs) || !fs.statSync(abs).isFile() || path.basename(abs) === 'vercel.json') {
      return send(404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const body = fs.readFileSync(abs);
    send(200, body, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream', 'Content-Length': body.length });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve({
        url: `http://${host}:${a.port}`,
        port: a.port,
        log,
        close: () => new Promise((r) => server.close(() => r())),
        server,
      });
    });
  });
}

module.exports = { serve, sourceRe };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const root = path.resolve(ROOT, arg('root', 'web'));
  serve({ port: Number(arg('port', 4173)), root }).then((s) => {
    console.log(`serving ${path.relative(ROOT, root) || '.'} at ${s.url}`);
  });
}
