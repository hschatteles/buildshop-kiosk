'use strict';
/* Build Shop Kiosk API: one shared service, every store's data kept apart.

   Data lives in one JSON file per store under BSK_DATA_DIR. The kiosk page is
   static (GitHub Pages) and calls this service for the things that must be
   shared: each store's "unavailable" settings and its suggestions.

   Secrets are NEVER in this file. PINs come from the host's environment:
     BSK_STORE_PIN      PIN every store uses (until per-store PINs are set)
     BSK_STORE_PINS     optional JSON, e.g. {"dallas":"1234"}, overrides per store
     BSK_REGIONAL_PIN   PIN for the all-stores view (defaults to BSK_STORE_PIN)
   Other settings: PORT, BSK_DATA_DIR, BSK_ALLOWED_ORIGINS (comma separated). */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORES = ['minneapolis', 'minnetonka', 'wilmington', 'columbia', 'scottsdale', 'dallas', 'westpalmbeach'];
const STATUSES = ['New', 'Planned', 'Done', 'Dismissed'];
const TYPES = ['Idea', 'Problem', 'Grip or service request', 'Other'];
const MAX_BODY = 20000, MAX_SUGGESTIONS = 500;

function createServer(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const DATA_DIR = env.BSK_DATA_DIR || path.join(__dirname, 'data');
  const ORIGINS = (env.BSK_ALLOWED_ORIGINS || 'https://hschatteles.github.io').split(',').map(s => s.trim()).filter(Boolean);
  const STORE_PIN = env.BSK_STORE_PIN || '';
  let perStore = {};
  try { perStore = env.BSK_STORE_PINS ? JSON.parse(env.BSK_STORE_PINS) : {}; } catch (_) { throw new Error('BSK_STORE_PINS is not valid JSON'); }
  const REGIONAL_PIN = env.BSK_REGIONAL_PIN || STORE_PIN;
  if (!STORE_PIN && !Object.keys(perStore).length) throw new Error('Set BSK_STORE_PIN (or BSK_STORE_PINS) before starting');
  if (!REGIONAL_PIN) throw new Error('Set BSK_REGIONAL_PIN');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const sha = s => crypto.createHash('sha256').update(String(s)).digest();
  const same = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));
  const pinFor = store => perStore[store] || STORE_PIN;

  function file(store) { return path.join(DATA_DIR, store + '.json'); }
  function read(store) {
    try { return JSON.parse(fs.readFileSync(file(store), 'utf8')); }
    catch (_) { return { availability: { grips: [], services: [] }, suggestions: [] }; }
  }
  function write(store, data) {
    const tmp = file(store) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file(store));
  }

  // Simple in-memory limiters (per client address).
  const buckets = {};
  function limited(key, max, windowMs) {
    const now = Date.now();
    const b = (buckets[key] = (buckets[key] || []).filter(t => now - t < windowMs));
    if (b.length >= max) return true;
    b.push(now);
    return false;
  }
  const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && ORIGINS.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-BSK-PIN');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
  }
  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function body(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (_) { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }

  // Returns null when allowed, or sends the error and returns true.
  function denied(req, res, store, needRegional) {
    const ip = clientIp(req);
    const pin = req.headers['x-bsk-pin'];
    const ok = needRegional ? same(pin, REGIONAL_PIN) : (same(pin, pinFor(store)) || same(pin, REGIONAL_PIN));
    if (ok) return false;
    const fails = (buckets['fail:' + ip] = (buckets['fail:' + ip] || []).filter(t => Date.now() - t < 5 * 60 * 1000));
    if (fails.length >= 10) { send(res, 429, { error: 'Too many wrong codes. Wait a few minutes.' }); return true; }
    fails.push(Date.now());
    send(res, 401, { error: 'Incorrect code' });
    return true;
  }
  function lockedOut(req, res) {
    const fails = (buckets['fail:' + clientIp(req)] || []).filter(t => Date.now() - t < 5 * 60 * 1000);
    if (fails.length >= 10) { send(res, 429, { error: 'Too many wrong codes. Wait a few minutes.' }); return true; }
    return false;
  }

  const cleanList = v => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.length <= 60))].slice(0, 200) : null;
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/health') return send(res, 200, { ok: true });

      if (p === '/api/login' && req.method === 'POST') {
        if (lockedOut(req, res)) return;
        const b = await body(req);
        const regional = b.scope === 'all';
        if (!regional && !STORES.includes(b.store)) return send(res, 400, { error: 'Unknown store' });
        req.headers['x-bsk-pin'] = String(b.pin || '');
        if (denied(req, res, b.store, regional)) return;
        return send(res, 200, { ok: true, role: regional ? 'regional' : 'store' });
      }

      if (p === '/api/availability') {
        const store = url.searchParams.get('store');
        if (req.method === 'GET') {
          if (!STORES.includes(store)) return send(res, 400, { error: 'Unknown store' });
          return send(res, 200, read(store).availability);
        }
        if (req.method === 'PUT') {
          const b = await body(req);
          if (!STORES.includes(b.store)) return send(res, 400, { error: 'Unknown store' });
          if (lockedOut(req, res) || denied(req, res, b.store, false)) return;
          const grips = cleanList(b.grips), services = cleanList(b.services);
          if (!grips || !services) return send(res, 400, { error: 'grips and services must be lists' });
          const d = read(b.store); d.availability = { grips, services }; write(b.store, d);
          return send(res, 200, d.availability);
        }
      }

      if (p === '/api/suggestions') {
        if (req.method === 'POST') {
          if (limited('sub:' + clientIp(req), 20, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many suggestions. Try again later.' });
          const b = await body(req);
          if (!STORES.includes(b.store)) return send(res, 400, { error: 'Unknown store' });
          const text = clip(b.text, 1500);
          if (!text) return send(res, 400, { error: 'Suggestion is empty' });
          const d = read(b.store);
          d.suggestions.unshift({
            id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            name: clip(b.name, 60),
            type: TYPES.includes(b.type) ? b.type : 'Other',
            text, status: 'New', at: new Date().toISOString()
          });
          d.suggestions = d.suggestions.slice(0, MAX_SUGGESTIONS);
          write(b.store, d);
          return send(res, 201, { ok: true });
        }
        if (req.method === 'GET') {
          const store = url.searchParams.get('store');
          if (lockedOut(req, res)) return;
          if (store === 'all') {
            if (denied(req, res, null, true)) return;
            const out = [];
            STORES.forEach(s => read(s).suggestions.forEach(x => out.push(Object.assign({ store: s }, x))));
            out.sort((a, b) => b.at.localeCompare(a.at));
            return send(res, 200, { suggestions: out });
          }
          if (!STORES.includes(store)) return send(res, 400, { error: 'Unknown store' });
          if (denied(req, res, store, false)) return;
          return send(res, 200, { suggestions: read(store).suggestions.map(x => Object.assign({ store }, x)) });
        }
        if (req.method === 'PATCH') {
          const b = await body(req);
          if (!STORES.includes(b.store)) return send(res, 400, { error: 'Unknown store' });
          if (lockedOut(req, res) || denied(req, res, b.store, false)) return;
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Bad status' });
          const d = read(b.store); const s = d.suggestions.find(x => x.id === b.id);
          if (!s) return send(res, 404, { error: 'Not found' });
          s.status = b.status; write(b.store, d);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          const store = url.searchParams.get('store'), id = Number(url.searchParams.get('id'));
          if (!STORES.includes(store)) return send(res, 400, { error: 'Unknown store' });
          if (lockedOut(req, res) || denied(req, res, store, true)) return;   // only Regional deletes
          const d = read(store); d.suggestions = d.suggestions.filter(x => x.id !== id); write(store, d);
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, e && e.message === 'too large' ? 413 : 400, { error: 'Bad request' });
    }
  });
  return server;
}

module.exports = { createServer, STORES };

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log('Build Shop Kiosk API listening on ' + port));
}
