// Speed: send the app's files and data compressed (brotli or gzip), and let browsers keep the app's files for a year
// (their names change with every release, so a new release is always picked up).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const wants = (req, enc) => new RegExp(`\\b${enc}\\b`).test(String(req.headers['accept-encoding'] || ''));

/** Pre-compressed, long-cached app files from dist/app-assets (compressed once in the background at start). */
export function appAssets(dist, prefix = '/app-assets/') {
  const dir = path.join(dist, prefix);
  const files = new Map(); // name -> { type, raw, br, gz }
  try {
    for (const name of fs.readdirSync(dir)) {
      const type = TYPES[path.extname(name)];
      if (!type) continue;
      const raw = fs.readFileSync(path.join(dir, name));
      files.set(name, { type, raw, gz: zlib.gzipSync(raw, { level: 9 }) });
    }
  } catch { /* no build yet */ }
  // brotli at its best setting is slow, so do it after start-up without holding anything up
  setTimeout(() => {
    for (const f of files.values()) {
      if (f.raw.length > 1024) f.br = zlib.brotliCompressSync(f.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: f.raw.length } });
    }
  }, 2000).unref();
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith(prefix)) return next();
    const f = files.get(req.path.slice(prefix.length));
    if (!f) return next();
    res.set({ 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable', Vary: 'Accept-Encoding' });
    let body = f.raw;
    if (f.br && wants(req, 'br')) { body = f.br; res.set('Content-Encoding', 'br'); }
    else if (wants(req, 'gzip')) { body = f.gz; res.set('Content-Encoding', 'gzip'); }
    res.set('Content-Length', String(body.length));
    return req.method === 'HEAD' ? res.end() : res.end(body);
  };
}

/** Compress JSON answers bigger than one network packet (mail lists, messages, contacts). */
export function compressJson(req, res, next) {
  const br = wants(req, 'br'); const gz = !br && wants(req, 'gzip');
  if (!br && !gz) return next();
  const json = res.json.bind(res);
  res.json = (data) => {
    if (res.headersSent || res.getHeader('Content-Encoding')) return json(data);
    const text = JSON.stringify(data);
    if (text === undefined || Buffer.byteLength(text) < 1400) return json(data);
    const body = br ? zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : zlib.gzipSync(text, { level: 6 });
    if (!res.getHeader('Content-Type')) res.set('Content-Type', 'application/json; charset=utf-8');
    res.set({ 'Content-Encoding': br ? 'br' : 'gzip', Vary: 'Accept-Encoding', 'Content-Length': String(body.length) });
    return res.end(body);
  };
  next();
}
