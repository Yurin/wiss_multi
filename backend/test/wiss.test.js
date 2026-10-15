const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const sharp = require('sharp');
const { WebSocket } = require('ws');
const { createWiss } = require('../wiss/router');
const { Store } = require('../wiss/store');
const { Integrations } = require('../wiss/integrations');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiss-test-'));
  const env = { WISS_ADMIN_TOKEN: 'test-admin-only', WISS_PUBLIC_URL: 'http://localhost' };
  const wiss = createWiss({ root, env, noWorker: true });
  const app = express(); app.use('/api/wiss', wiss.router);
  const server = createServer(app); server.on('upgrade', wiss.upgrade); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { wiss.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(route, token, method = 'GET', body, status = 200) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}/api/wiss${route}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data).slice(0, 200)}`); return data;
  }
  const session = await request('/sessions', null, 'POST', {}, 201);
  const sessionPath = `/sessions/${session.sessionId}`;
  const state = () => request(sessionPath, session.token);
  const joinCode = (await state()).joinCode;
  async function join(research = true, publication = true) {
    const c = await request('/join', null, 'POST', { joinCode }, 201);
    await request(`${sessionPath}/consent`, c.token, 'POST', { research, publication }); return c;
  }
  const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#889999' } }).jpeg().toBuffer();
  const png = await sharp(Buffer.from('<svg width="400" height="300"><rect x="10" y="10" width="30" height="50" fill="red"/></svg>')).png().toBuffer();
  async function capture(captureId = randomUUID()) {
    const form = new FormData(); form.append('captureId', captureId); form.append('expectedVersion', (await state()).version); form.append('photo', new Blob([jpg], { type: 'image/jpeg' }), 'photo.jpg');
    return request(`${sessionPath}/photos`, session.token, 'POST', form, 201);
  }
  const decision = (p, value, status = 200) => request(`${sessionPath}/photos/${p.id}/decision`, session.token, 'POST', { decision: value }, status);
  async function register(p, overrides = {}, status = 201) {
    const form = new FormData(); form.append('name', '=テストフレーム'); form.append('subjectCount', '2');
    for (const key of ['reference', 'box', 'silhouette', 'box_face']) {
      if (overrides[key] === null) continue;
      const data = overrides[key] || (key === 'reference' ? jpg : png);
      form.append(key, new Blob([data], { type: key === 'reference' ? 'image/jpeg' : 'image/png' }), key);
    }
    return request(`/admin/photos/${p.id}/reference`, env.WISS_ADMIN_TOKEN, 'POST', form, status);
  }
  return { root, wiss, env, base, request, session, sessionPath, state, joinCode, join, jpg, png, capture, decision, register };
}

test('six subjects, independent consent, authority and competing activation, WebSocket fan-out', async t => {
  const f = await fixture(t), { request, sessionPath, session, wiss } = f;
  const subjects = await Promise.all(Array.from({ length: 6 }, () => f.join()));
  await request('/join', null, 'POST', { joinCode: f.joinCode }, 409);
  let s = await f.state(); assert.equal(s.subjects.length, 6); assert.ok(subjects.some(p => p.subjectId === s.representativeId));
  const representative = subjects.find(p => p.subjectId === s.representativeId), other = subjects.find(p => p !== representative);
  await request(`${sessionPath}/active-frame`, other.token, 'PUT', { frameId: null, expectedVersion: s.version }, 403);
  await request(`${sessionPath}/representative`, session.token, 'POST', { subjectId: other.subjectId, expectedVersion: s.version });
  s = await f.state(); assert.equal(s.representativeId, other.subjectId);
  const p = await f.capture(); await f.decision(p, 'saved'); const ref = await f.register(p);
  await request(`/admin/references/${ref.id}`, f.env.WISS_ADMIN_TOKEN, 'PATCH', { status: 'published' });
  await request(`${sessionPath}/view`, other.token, 'POST', { frameId: ref.variants[0].id });
  await request(`${sessionPath}/proposals`, representative.token, 'POST', { frameId: ref.variants[0].id });
  s = await f.state();
  const responses = await Promise.all([0, 1].map(async () => {
    const response = await fetch(`${f.base}/api/wiss${sessionPath}/active-frame`, { method: 'PUT', headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ frameId: ref.variants[0].id, expectedVersion: s.version }) }); return response.status;
  }));
  assert.deepEqual(responses.sort(), [200, 409]);
  assert.equal((await f.state()).activeFrameId, ref.variants[0].id);
  const shot = await f.capture(); assert.equal(wiss.store.data.photos[shot.id].frameVariantId, ref.variants[0].id);
  const stats = await request('/admin/analytics', f.env.WISS_ADMIN_TOKEN);
  assert.deepEqual([stats.frames[0].viewed, stats.frames[0].proposed, stats.frames[0].activated, stats.frames[0].captured], [1, 1, 1, 1]);
  const sockets = [];
  for (const c of [session, ...subjects]) {
    const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws/wiss?sessionId=${session.sessionId}&token=${c.token}`);
    await once(ws, 'open'); sockets.push(ws);
  }
  t.after(() => sockets.forEach(ws => ws.terminate()));
  const binaryMessages = sockets.slice(1).map(ws => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Video delivery timeout')), 3000);
    ws.on('message', (data, binary) => { if (binary) { clearTimeout(timeout); resolve(data); } });
  }));
  sockets[0].send(f.jpg);
  for (const bytes of await Promise.all(binaryMessages)) assert.deepEqual(bytes, f.jpg);
  await request(`/admin/references/${ref.id}`, f.env.WISS_ADMIN_TOKEN, 'PATCH', { status: 'ready' });
  assert.equal((await f.state()).activeFrameId, null);
  assert.equal((await request('/library')).length, 0);
});

test('consent snapshots, delete removes original, retry only failed destination, persistence and private share', async t => {
  const f = await fixture(t), { request, sessionPath, session, wiss } = f;
  const a = await f.join(true, true), b = await f.join(false, true);
  const first = await f.capture();
  await request(`${sessionPath}/consent`, b.token, 'POST', { research: true, publication: true });
  await f.decision(first, 'saved'); await f.decision(first, 'saved');
  assert.equal(wiss.store.data.jobs[`research:${first.id}`], undefined);
  assert.ok(wiss.store.data.notifications[first.id]);
  assert.equal(wiss.store.data.events.filter(e => e.photoId === first.id && e.eventType === 'photo_saved').length, 1);
  const second = await f.capture(); await f.decision(second, 'saved');
  const deleted = await f.capture(); const deletedPath = wiss.store.assetPath(wiss.store.data.photos[deleted.id].asset);
  assert.ok(fs.existsSync(deletedPath)); await f.decision(deleted, 'deleted'); assert.equal(fs.existsSync(deletedPath), false);
  await f.decision(deleted, 'saved', 409);
  await request(`${sessionPath}/photos/${deleted.id}/image`, session.token, 'GET', null, 404);
  const calls = [];
  const worker = new Integrations(wiss.store, f.env, { drive: async j => { calls.push(j.id); if (j.destination === 'research' && calls.filter(x => x === j.id).length === 1) throw new Error('temporary'); return { id: 'remote' }; }, mail: async () => ({ id: 'mail' }) });
  await worker.tick();
  assert.equal(wiss.store.data.jobs[`shared:${second.id}`].status, 'succeeded');
  assert.equal(wiss.store.data.jobs[`research:${second.id}`].status, 'failed');
  await request(`${sessionPath}/retry`, session.token, 'POST'); await worker.tick();
  assert.equal(calls.filter(x => x === `shared:${second.id}`).length, 1);
  assert.equal(calls.filter(x => x === `research:${second.id}`).length, 2);
  const reloaded = new Store(f.root); assert.equal(reloaded.data.photos[first.id].decision, 'saved'); assert.equal(reloaded.data.jobs[`research:${second.id}`].status, 'succeeded');
  const links = await request(`${sessionPath}/links`, session.token); assert.ok(links.joinQR.startsWith('data:image/png'));
  const shareToken = new URL(links.shareURL).hash.slice(1).split('/')[1];
  assert.equal((await request(`/share/${session.sessionId}`, shareToken)).length, 2);
  await request(`/share/${session.sessionId}`, a.token, 'GET', null, 401);
  const another = await request('/sessions', null, 'POST', {}, 201);
  await request(`/share/${another.sessionId}`, shareToken, 'GET', null, 401);
  await request(`${sessionPath}/photos/${first.id}/image`, another.token, 'GET', null, 401);
  await request('/admin/dashboard', a.token, 'GET', null, 401);
  assert.equal(fs.readFileSync(wiss.store.assetPath(wiss.store.data.photos[first.id].asset)).equals(f.jpg), true);
});

test('PNG validation, publication requires consent, complete WOz publication and CSV escaping', async t => {
  const f = await fixture(t), subject = await f.join(true, false);
  let p = await f.capture(); await f.decision(p, 'saved');
  await f.register(p, {}, 403); assert.equal(Object.keys(f.wiss.store.data.notifications).length, 0);
  await f.request(`${f.sessionPath}/consent`, subject.token, 'POST', { research: false, publication: true });
  p = await f.capture(); await f.decision(p, 'saved');
  await f.register(p, { silhouette: null }, 400);
  const opaque = await sharp({ create: { width: 400, height: 300, channels: 4, background: '#ff0000' } }).png().toBuffer();
  await f.register(p, { box: opaque }, 400);
  const wrongSize = await sharp(f.png).resize(800, 600).toBuffer(); await f.register(p, { box: wrongSize }, 400);
  const portrait = await sharp(f.png).resize(300, 400).toBuffer(); await f.register(p, { box: portrait }, 400);
  const ref = await f.register(p);
  assert.equal(Object.keys(f.wiss.store.data.references).length, 1);
  assert.equal((await f.request('/library')).length, 0);
  await f.request(`/admin/references/${ref.id}`, f.env.WISS_ADMIN_TOKEN, 'PATCH', { status: 'published' });
  const list = await f.request('/library'); assert.equal(list.length, 1); assert.equal(list[0].variants.length, 3);
  const response = await fetch(`${f.base}${list[0].variants[0].imageURL}`); assert.equal(response.status, 200);
  const csv = await f.request('/admin/export.csv', f.env.WISS_ADMIN_TOKEN); assert.ok(csv.includes("'=テストフレーム"));
  const other = await f.request('/sessions', null, 'POST', {}, 201);
  const otherState = await f.request(`/sessions/${other.sessionId}`, other.token);
  const otherSubject = await f.request('/join', null, 'POST', { joinCode: otherState.joinCode }, 201);
  const s = await f.request(`/sessions/${other.sessionId}`, other.token);
  const selected = await f.request(`/sessions/${other.sessionId}/active-frame`, otherSubject.token, 'PUT', { expectedVersion: s.version, frameId: list[0].variants[1].id });
  assert.equal(selected.reference.id, ref.id);
  await f.request(`/admin/references/${ref.id}`, f.env.WISS_ADMIN_TOKEN, 'PATCH', { status: 'deleted' });
  assert.equal((await f.request(`/sessions/${other.sessionId}`, other.token)).mode, 'free');
});

test('capture version race, unanswered consent, invalid image and draft expiry', async t => {
  const f = await fixture(t);
  const subject = await f.request('/join', null, 'POST', { joinCode: f.joinCode }, 201);
  const form = () => { const b = new FormData(); b.append('captureId', randomUUID()); b.append('expectedVersion', '1'); b.append('photo', new Blob([f.jpg], { type: 'image/jpeg' }), 'photo.jpg'); return b; };
  await f.request(`${f.sessionPath}/photos`, f.session.token, 'POST', form(), 409);
  await f.request(`${f.sessionPath}/consent`, subject.token, 'POST', { research: true, publication: true });
  await f.request(`${f.sessionPath}/photos`, f.session.token, 'POST', form(), 409);
  assert.equal(fs.readdirSync(path.join(f.root, 'assets')).length, 0);
  const draft = await f.capture(); const asset = f.wiss.store.assetPath(f.wiss.store.data.photos[draft.id].asset);
  f.wiss.store.cleanup(-1); assert.equal(fs.existsSync(asset), false);
  assert.equal(f.wiss.store.data.photos[draft.id].decision, 'deleted');
});

test('SMTP uncertain delivery is not resent after restart; initial templates are classified separately', async t => {
  const f = await fixture(t); await f.join(); const p = await f.capture(); await f.decision(p, 'saved');
  f.wiss.store.transaction(d => { d.jobs[`mail:${p.id}`].status = 'running'; });
  let mailed = 0;
  const worker = new Integrations(f.wiss.store, f.env, { drive: async () => ({}), mail: async () => { mailed++; } });
  await worker.tick(); assert.equal(mailed, 0); assert.equal(f.wiss.store.data.jobs[`mail:${p.id}`].status, 'uncertain');
  await f.request(`/admin/jobs/${encodeURIComponent(`mail:${p.id}`)}/resolve`, f.env.WISS_ADMIN_TOKEN, 'POST', { resolution: 'delivered' });
  await worker.tick(); assert.equal(mailed, 0);
  const form = new FormData(); form.append('rightsConfirmed', 'true'); form.append('subjectCount', '2'); form.append('photo', new Blob([f.jpg], { type: 'image/jpeg' }), 'original.jpg');
  const initial = await f.request('/admin/initial-photos', f.env.WISS_ADMIN_TOKEN, 'POST', form, 201);
  await f.request(`/share/${initial.sessionId}`, null, 'GET', null, 401);
  const ref = await f.register(initial); assert.equal(ref.origin, 'initial');
});

test('Drive uncertain create retries the same object without duplicate upload', async t => {
  const f = await fixture(t);
  const worker = new Integrations(f.wiss.store, f.env);
  const remote = new Set(); let uploads = 0;
  const drive = { files: {
    get: async ({ fileId }) => { if (!remote.has(fileId)) throw Object.assign(new Error('not found'), { code: 404 }); return { data: { id: fileId } }; },
    create: async ({ requestBody }) => { uploads++; remote.add(requestBody.id); throw Object.assign(new Error('response lost'), { code: 503 }); }
  } };
  await assert.rejects(worker.ensureFile(drive, 'persisted-id', { id: 'persisted-id' }), /response lost/);
  await worker.ensureFile(drive, 'persisted-id', { id: 'persisted-id' });
  assert.equal(uploads, 1);
  const conflict = { files: { get: async () => { throw { code: 404 }; }, create: async () => { throw { code: 409 }; } } };
  await worker.ensureFile(conflict, 'persisted-id', { id: 'persisted-id' });
  const forbidden = { files: { get: async () => { throw Object.assign(new Error('permission denied'), { code: 403 }); } } };
  await assert.rejects(worker.ensureFile(forbidden, 'id', { id: 'id' }), /permission denied/);
});
