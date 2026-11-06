'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../server/server.js');

const ORIGIN = 'https://hschatteles.github.io';
function boot(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-'));
  const env = Object.assign({ BSK_DATA_DIR: dir, BSK_STORE_PIN: '1111', BSK_REGIONAL_PIN: '9999' }, extra);
  const srv = createServer({ env });
  return new Promise(r => srv.listen(0, () => {
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = (m, p, b, pin, origin) => fetch(base + p, {
      method: m,
      headers: Object.assign({ 'Content-Type': 'application/json' }, pin ? { 'X-BSK-PIN': pin } : {}, origin ? { Origin: origin } : {}),
      body: b ? JSON.stringify(b) : undefined
    }).then(async x => ({ status: x.status, headers: x.headers, json: await x.json().catch(() => null) }));
    r({ srv, call });
  }));
}

test('refuses to start without a PIN', () => {
  assert.throws(() => createServer({ env: { BSK_DATA_DIR: os.tmpdir() } }), /BSK_STORE_PIN/);
});

test('availability is separate per store and needs the PIN to change', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('PUT', '/api/availability', { store: 'dallas', grips: ['a'], services: ['regrip'] })).status, 401);
  assert.equal((await call('PUT', '/api/availability', { store: 'dallas', grips: ['a'], services: ['regrip'] }, '0000')).status, 401);
  assert.equal((await call('PUT', '/api/availability', { store: 'dallas', grips: ['a'], services: ['regrip'] }, '1111')).status, 200);
  assert.deepEqual((await call('GET', '/api/availability?store=dallas')).json, { grips: ['a'], services: ['regrip'] });
  assert.deepEqual((await call('GET', '/api/availability?store=columbia')).json, { grips: [], services: [] });
  assert.equal((await call('GET', '/api/availability?store=nowhere')).status, 400);
  srv.close();
});

test('suggestions: anyone can submit, each store sees only its own, regional sees all', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('POST', '/api/suggestions', { store: 'dallas', name: 'Sam', type: 'Idea', text: 'Add X' })).status, 201);
  assert.equal((await call('POST', '/api/suggestions', { store: 'columbia', text: 'Fix Y' })).status, 201);
  assert.equal((await call('POST', '/api/suggestions', { store: 'dallas', text: '  ' })).status, 400);
  assert.equal((await call('GET', '/api/suggestions?store=dallas')).status, 401);   // reading needs the PIN
  const d = await call('GET', '/api/suggestions?store=dallas', null, '1111');
  assert.equal(d.json.suggestions.length, 1);
  assert.equal(d.json.suggestions[0].text, 'Add X');
  assert.equal((await call('GET', '/api/suggestions?store=all', null, '1111')).status, 401);  // store PIN is not regional
  const all = await call('GET', '/api/suggestions?store=all', null, '9999');
  assert.equal(all.json.suggestions.length, 2);
  assert.deepEqual(all.json.suggestions.map(x => x.store).sort(), ['columbia', 'dallas']);
  srv.close();
});

test('status changes need a PIN; only regional can delete', async () => {
  const { srv, call } = await boot();
  await call('POST', '/api/suggestions', { store: 'dallas', text: 'Idea 1' });
  const s = (await call('GET', '/api/suggestions?store=dallas', null, '1111')).json.suggestions[0];
  assert.equal((await call('PATCH', '/api/suggestions', { store: 'dallas', id: s.id, status: 'Planned' })).status, 401);
  assert.equal((await call('PATCH', '/api/suggestions', { store: 'dallas', id: s.id, status: 'Planned' }, '1111')).status, 200);
  assert.equal((await call('GET', '/api/suggestions?store=dallas', null, '1111')).json.suggestions[0].status, 'Planned');
  assert.equal((await call('DELETE', `/api/suggestions?store=dallas&id=${s.id}`, null, '1111')).status, 401);
  assert.equal((await call('DELETE', `/api/suggestions?store=dallas&id=${s.id}`, null, '9999')).status, 200);
  assert.equal((await call('GET', '/api/suggestions?store=dallas', null, '1111')).json.suggestions.length, 0);
  srv.close();
});

test('per-store PINs: one store PIN cannot open another store', async () => {
  const { srv, call } = await boot({ BSK_STORE_PINS: '{"dallas":"2222"}' });
  assert.equal((await call('GET', '/api/suggestions?store=dallas', null, '1111')).status, 401);
  assert.equal((await call('GET', '/api/suggestions?store=dallas', null, '2222')).status, 200);
  assert.equal((await call('GET', '/api/suggestions?store=columbia', null, '2222')).status, 401);
  assert.equal((await call('GET', '/api/suggestions?store=columbia', null, '1111')).status, 200);
  srv.close();
});

test('login reports role and locks out after repeated wrong codes', async () => {
  const { srv, call } = await boot();
  assert.deepEqual((await call('POST', '/api/login', { store: 'dallas', pin: '1111' })).json, { ok: true, role: 'store' });
  assert.deepEqual((await call('POST', '/api/login', { scope: 'all', pin: '9999' })).json, { ok: true, role: 'regional' });
  assert.equal((await call('POST', '/api/login', { scope: 'all', pin: '1111' })).status, 401);
  for (let i = 0; i < 12; i++) await call('POST', '/api/login', { store: 'dallas', pin: 'bad' });
  assert.equal((await call('POST', '/api/login', { store: 'dallas', pin: '1111' })).status, 429);
  srv.close();
});

test('CORS only allows the kiosk origin', async () => {
  const { srv, call } = await boot();
  assert.equal((await call('GET', '/api/availability?store=dallas', null, null, ORIGIN)).headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await call('GET', '/api/availability?store=dallas', null, null, 'https://evil.example')).headers.get('access-control-allow-origin'), null);
  srv.close();
});

test('data survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsk-'));
  const env = { BSK_DATA_DIR: dir, BSK_STORE_PIN: '1111' };
  let s1 = createServer({ env }); await new Promise(r => s1.listen(0, r));
  await fetch('http://127.0.0.1:' + s1.address().port + '/api/suggestions', { method: 'POST', body: JSON.stringify({ store: 'dallas', text: 'keep me' }) });
  s1.close();
  let s2 = createServer({ env }); await new Promise(r => s2.listen(0, r));
  const r = await fetch('http://127.0.0.1:' + s2.address().port + '/api/suggestions?store=dallas', { headers: { 'X-BSK-PIN': '1111' } }).then(x => x.json());
  assert.equal(r.suggestions[0].text, 'keep me');
  s2.close();
});
