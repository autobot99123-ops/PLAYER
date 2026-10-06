'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIDEOS_DIR = path.resolve(process.env.VIDEOS_DIR || path.join(os.homedir(), 'Videos'));

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv',
  '.mpg', '.mpeg', '.m2ts', '.mts', '.ts', '.3gp', '.ogv', '.vob', '.asf'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.vob': 'video/x-ms-vob',
  '.asf': 'video/x-ms-asf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Resolve `name` inside `base`, refusing anything that escapes it. */
function safeResolve(base, name) {
  const target = path.resolve(base, name);
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/* ------------------------------------------------------------------ */
/* /api/videos - list playable files from VIDEOS_DIR                    */
/* ------------------------------------------------------------------ */
async function listVideos() {
  let entries = [];
  try {
    entries = await fsp.readdir(VIDEOS_DIR, { withFileTypes: true });
  } catch (err) {
    return { dir: VIDEOS_DIR, exists: false, error: err.code || String(err), videos: [] };
  }

  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) continue;
    let stat;
    try {
      stat = await fsp.stat(path.join(VIDEOS_DIR, entry.name));
    } catch {
      continue;
    }
    videos.push({
      name: entry.name,
      size: stat.size,
      mtime: stat.mtimeMs,
      url: `/stream/${encodeURIComponent(entry.name)}`,
    });
  }

  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { dir: VIDEOS_DIR, exists: true, videos };
}

/* ------------------------------------------------------------------ */
/* /stream/<name> - byte-range aware file streaming (needed for seek)   */
/* ------------------------------------------------------------------ */
function streamFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const total = stat.size;
    const type = mimeFor(filePath);
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);

    if (start === null && end !== null) {
      // suffix range: last N bytes
      start = Math.max(0, total - end);
      end = total - 1;
    } else if (start === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    } else if (end === null || end >= total) {
      end = total - 1;
    }

    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */
function serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': stat.size,
      // never cache: a stale app.js is what caused the silent-player bug
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  if (pathname === '/api/videos') {
    try {
      sendJson(res, 200, await listVideos());
    } catch (err) {
      sendJson(res, 500, { error: String(err), videos: [] });
    }
    return;
  }

  if (pathname.startsWith('/stream/')) {
    const name = pathname.slice('/stream/'.length);
    const filePath = safeResolve(VIDEOS_DIR, name);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad path');
      return;
    }
    streamFile(req, res, filePath);
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = safeResolve(PUBLIC_DIR, rel);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad path');
    return;
  }
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Glass Neo Player');
  console.log('  ----------------');
  console.log(`  URL          : http://${HOST}:${PORT}`);
  console.log(`  Videos folder: ${VIDEOS_DIR}`);
  console.log(`  Change it    : set VIDEOS_DIR, e.g. $env:VIDEOS_DIR="D:\\Movies"`);
  console.log('');
  console.log('  Press F11 in Chrome for true fullscreen.');
  console.log('  Press N (or minimise) so the popup follows you across tabs.');
  console.log('');
});
