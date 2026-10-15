const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { Store, check, id, hash, now } = require('./store');
const { Integrations } = require('./integrations');

const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const credential = req => req.get('Authorization')?.replace(/^Bearer /, '') || req.query.token;
const KINDS = ['box', 'silhouette', 'box_face'];

function createWiss(options = {}) {
  const env = options.env || process.env;
  const store = new Store(options.root || env.WISS_DATA_DIR || path.join(__dirname, '..', 'data', 'wiss'));
  store.cleanup(Number(env.WISS_DRAFT_TTL_MS || 3600000));
  const integrations = new Integrations(store, env, options.adapters);
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 4, fields: 10 } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const clients = new Map();
  router.use(express.json({ limit: '64kb' }));
  router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next(); });
  const admin = (req, res, next) => {
    if (!env.WISS_ADMIN_TOKEN || hash(credential(req)) !== hash(env.WISS_ADMIN_TOKEN)) return res.status(401).json({ error: '管理者認証が必要です' });
    next();
  };
  function auth(req, photographer = false) {
    const s = store.session(store.data, req.params.sessionId);
    const actor = store.actor(s, credential(req));
    check(!photographer || actor.role === 'photographer', '撮影者専用です', 403);
    return { s, actor };
  }
  function photoJobs(photoId) { return Object.values(store.data.jobs).filter(j => j.photoId === photoId).map(({ id, destination, status, attempts, error }) => ({ id, destination, status, attempts, error })); }
  function publicPhoto(p) {
    return { id: p.id, sessionId: p.sessionId, capturedAt: p.capturedAt, subjectCount: p.subjectCount, research: p.research, publication: p.publication,
      mode: p.mode, decision: p.decision, status: p.status, referenceId: p.referenceId, jobs: photoJobs(p.id),
      imageURL: `/api/wiss/sessions/${p.sessionId}/photos/${p.id}/image` };
  }
  function state(sessionId) {
    const s = store.session(store.data, sessionId);
    const online = [...clients.values()].filter(c => c.sessionId === sessionId);
    return { ...store.publicSession(s), subjects: store.publicSession(s).subjects.map(p => ({ ...p, connected: online.some(c => c.actor.id === p.id) })),
      photographerConnected: online.some(c => c.actor.role === 'photographer'),
      photos: Object.values(store.data.photos).filter(p => p.sessionId === s.id && p.decision !== 'deleted').map(publicPhoto) };
  }
  function broadcast(sessionId) {
    const payload = JSON.stringify({ type: 'state', session: state(sessionId) });
    for (const [ws, c] of clients) if (c.sessionId === sessionId && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  function broadcastAll() { for (const s of Object.values(store.data.sessions)) broadcast(s.id); }
  function saveAsset(buffer, ext) {
    const name = `${id()}.${ext}`;
    fs.writeFileSync(store.assetPath(name), buffer, { mode: 0o600 });
    return name;
  }
  async function validateImage(file, transparent = false) {
    check(file, '画像が不足しています');
    const image = sharp(file.buffer, { limitInputPixels: 24 * 1024 * 1024 });
    const m = await image.metadata();
    check(['jpeg', 'png'].includes(m.format) && (m.pages || 1) === 1, 'JPEGまたは単一PNGを使用してください');
    check(m.width * 3 === m.height * 4 && m.width >= 320 && m.width <= 6000, '画像は横4:3、幅320〜6000pxにしてください');
    check(!m.orientation || m.orientation === 1, '画像のEXIF回転を適用してから登録してください');
    if (transparent) {
      check(m.format === 'png' && m.hasAlpha, '透過PNGを使用してください');
      const stats = await image.stats();
      check(stats.channels.at(-1).min === 0 && stats.channels.at(-1).max > 0, '完全に透明な背景画素と描画の両方が必要です');
    }
    // Decode fully and remove metadata; corrupt payloads must not enter storage.
    const bytes = transparent ? await image.png().toBuffer() : await image.jpeg({ quality: 95 }).toBuffer();
    return { bytes, width: m.width, height: m.height, format: m.format };
  }

  router.post('/sessions', wrap((req, res) => res.status(201).json(store.createSession())));
  router.post('/join', wrap((req, res) => { const result = store.join(req.body.joinCode); broadcast(result.sessionId); res.status(201).json(result); }));
  router.get('/sessions/:sessionId', wrap((req, res) => { auth(req); res.json(state(req.params.sessionId)); }));
  for (const action of ['consent', 'representative', 'proposals', 'view', 'close', 'active-frame']) {
    router[action === 'active-frame' ? 'put' : 'post'](`/sessions/:sessionId/${action}`, wrap((req, res) => {
      store.mutate(req.params.sessionId, credential(req), action, req.body);
      broadcast(req.params.sessionId); res.json(state(req.params.sessionId));
    }));
  }
  router.get('/library', wrap((req, res) => res.json(Object.values(store.data.references).filter(r => r.status === 'published').map(r => store.publicReference(r)))));
  router.get('/library/:referenceId/:kind', wrap((req, res) => {
    const r = store.data.references[req.params.referenceId];
    check(r?.status === 'published', '公開画像が見つかりません', 404);
    const asset = req.params.kind === 'reference' ? r.asset : r.variants.find(v => v.kind === req.params.kind)?.asset;
    check(asset, '画像が見つかりません', 404); res.sendFile(store.assetPath(asset));
  }));
  router.post('/sessions/:sessionId/photos', (req, res, next) => { try { auth(req, true); next(); } catch (e) { next(e); } }, upload.single('photo'), wrap(async (req, res) => {
    const { s } = auth(req, true);
    const existing = Object.values(store.data.photos).find(p => p.sessionId === s.id && p.captureId === req.body.captureId);
    if (existing) return res.json(publicPhoto(existing));
    const validated = await validateImage(req.file);
    // Preserve the exact captured original; the decoded bytes above only validate it.
    const asset = saveAsset(req.file.buffer, validated.format === 'png' ? 'png' : 'jpg');
    try {
      const p = store.capture(s.id, credential(req), { captureId: req.body.captureId, expectedVersion: Number(req.body.expectedVersion) }, asset);
      if (p.asset !== asset) fs.rmSync(store.assetPath(asset), { force: true });
      broadcast(s.id); res.status(201).json(publicPhoto(p));
    } catch (e) { fs.rmSync(store.assetPath(asset), { force: true }); throw e; }
  }));
  router.post('/sessions/:sessionId/photos/:photoId/decision', wrap((req, res) => {
    const p = store.decide(req.params.sessionId, credential(req), req.params.photoId, req.body.decision);
    if (p.decision === 'deleted') fs.rmSync(store.assetPath(p.asset), { force: true });
    broadcast(p.sessionId); res.json(publicPhoto(p));
  }));
  router.get('/sessions/:sessionId/photos/:photoId/image', wrap((req, res) => {
    auth(req); const p = store.data.photos[req.params.photoId];
    check(p?.sessionId === req.params.sessionId && p.decision !== 'deleted', '写真が見つかりません', 404);
    res.sendFile(store.assetPath(p.asset));
  }));
  function retryJobs(predicate) {
    store.transaction(d => { for (const j of Object.values(d.jobs)) if (predicate(j) && j.status === 'failed') Object.assign(j, { status: 'pending', attempts: 0, nextAttemptAt: 0 }); });
  }
  router.post('/sessions/:sessionId/retry', wrap((req, res) => { auth(req, true); retryJobs(j => j.sessionId === req.params.sessionId && j.destination !== 'mail'); res.json({ ok: true }); }));
  router.get('/sessions/:sessionId/links', wrap(async (req, res) => {
    const { s } = auth(req, true);
    const base = (env.WISS_PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
    const joinURL = `${base}/booth/join.html#${s.joinCode}`;
    const shareURL = `${base}/booth/share.html#${s.id}/${s.shareToken}`;
    res.json({ joinURL, shareURL, joinQR: await QRCode.toDataURL(joinURL), shareQR: await QRCode.toDataURL(shareURL) });
  }));
  function shareAuth(req) {
    const s = store.session(store.data, req.params.sessionId);
    check(typeof s.shareToken === 'string' && !!credential(req) && hash(credential(req)) === hash(s.shareToken), '共有資格が無効です', 401); return s;
  }
  router.get('/share/:sessionId', wrap((req, res) => {
    const s = shareAuth(req);
    res.json(Object.values(store.data.photos).filter(p => p.sessionId === s.id && p.decision === 'saved').map(p => ({ id: p.id, capturedAt: p.capturedAt, imageURL: `/api/wiss/share/${s.id}/${p.id}` })));
  }));
  router.get('/share/:sessionId/:photoId', wrap((req, res) => {
    const s = shareAuth(req), p = store.data.photos[req.params.photoId];
    check(p?.sessionId === s.id && p.decision === 'saved', '写真が見つかりません', 404); res.sendFile(store.assetPath(p.asset));
  }));

  router.use('/admin', admin);
  router.post('/admin/initial-photos', upload.single('photo'), wrap(async (req, res) => {
    check(req.body.rightsConfirmed === 'true', '研究保存とライブラリ公開に利用可能な初期素材であることを確認してください');
    const validated = await validateImage(req.file);
    const asset = saveAsset(req.file.buffer, validated.format === 'png' ? 'png' : 'jpg');
    try {
      const p = store.transaction(d => {
        let s = Object.values(d.sessions).find(s => s.internalLibrary);
        if (!s) {
          s = { id: id(), internalLibrary: true, closed: true, subjects: [], proposals: [], version: 0, activeFrameId: null, mode: 'free', createdAt: now() };
          d.sessions[s.id] = s;
        }
        const count = Number(req.body.subjectCount);
        check(Number.isInteger(count) && count >= 1 && count <= 6, '人数は1〜6人です');
        const p = { id: id(), sessionId: s.id, capturedAt: now(), subjectCount: count, consents: [],
          research: true, publication: true, origin: 'initial', mode: 'free', asset, decision: 'saved', status: 'pending' };
        d.photos[p.id] = p;
        store.job(d, `research:${p.id}`, { destination: 'research', photoId: p.id, sessionId: p.sessionId, asset });
        store.event(d, 'initial_reference_uploaded', { photoId: p.id, subjectCount: count, origin: 'initial' });
        return p;
      }); res.status(201).json(publicPhoto(p));
    } catch (e) { fs.rmSync(store.assetPath(asset), { force: true }); throw e; }
  }));
  router.get('/admin/dashboard', wrap((req, res) => {
    const photos = Object.values(store.data.photos).filter(p => p.decision === 'saved' && p.mode === 'free');
    res.json({ photos: photos.map(publicPhoto), references: Object.values(store.data.references).filter(r => r.status !== 'deleted').map(r => ({ ...store.publicReference(r), sourcePhotoId: r.sourcePhotoId })),
      counts: { pending: photos.filter(p => p.publication && p.status === 'pending').length, processing: photos.filter(p => p.status === 'processing').length,
        published: Object.values(store.data.references).filter(r => r.status === 'published').length },
      notifications: Object.values(store.data.notifications), jobs: Object.values(store.data.jobs).map(({ id, destination, status, attempts, error }) => ({ id, destination, status, attempts, error })) });
  }));
  router.get('/admin/photos/:photoId/image', wrap((req, res) => {
    const p = store.data.photos[req.params.photoId];
    check(p?.decision === 'saved' && (p.publication || p.research), '閲覧同意のある保存写真がありません', 403);
    res.sendFile(store.assetPath(p.asset));
  }));
  router.patch('/admin/photos/:photoId', wrap((req, res) => {
    store.transaction(d => {
      const p = d.photos[req.params.photoId];
      check(p?.decision === 'saved' && p.publication && p.mode === 'free', 'フレーム化対象ではありません', 403);
      check(['pending', 'processing', 'rejected'].includes(req.body.status), '状態が無効です');
      check(p.status !== 'published', '先にフレームを非公開にしてください', 409);
      p.status = req.body.status;
    }); res.json({ ok: true });
  }));
  router.post('/admin/photos/:photoId/reference', upload.fields([{ name: 'reference', maxCount: 1 }, ...KINDS.map(name => ({ name, maxCount: 1 }))]), wrap(async (req, res) => {
    const p = store.data.photos[req.params.photoId];
    check(p?.decision === 'saved' && p.publication && p.mode === 'free', '公開同意のある自由撮影写真が必要です', 403);
    check(p.status !== 'published', '編集前に非公開にしてください', 409);
    check(typeof req.body.name === 'string' && req.body.name.trim().length > 0 && req.body.name.length <= 100, 'フレーム名は1〜100文字です');
    const subjectCount = Number(req.body.subjectCount);
    check(Number.isInteger(subjectCount) && subjectCount >= 1 && subjectCount <= 6, '人数は1〜6人です');
    const reference = await validateImage(req.files.reference?.[0]);
    const variants = [];
    for (const kind of KINDS) {
      const v = await validateImage(req.files[kind]?.[0], true);
      check(v.width === reference.width && v.height === reference.height, 'すべての画像を同じ寸法にしてください');
      variants.push({ ...v, kind });
    }
    const files = [];
    try {
      const asset = saveAsset(reference.bytes, 'jpg'); files.push(asset);
      const savedVariants = variants.map(v => { const asset = saveAsset(v.bytes, 'png'); files.push(asset); return { id: id(), kind: v.kind, asset }; });
      const result = store.transaction(d => {
        const current = d.photos[p.id];
        check(current.status !== 'published', '写真は既に公開されています', 409);
        const old = Object.values(d.references).find(r => r.sourcePhotoId === p.id && r.status !== 'deleted');
        check(!old || old.status !== 'published', '先に非公開にしてください', 409);
        if (old) old.status = 'deleted';
        const r = { id: id(), sourcePhotoId: p.id, name: req.body.name.trim(), subjectCount, origin: p.origin === 'initial' ? 'initial' : 'participant',
          asset, variants: savedVariants, width: reference.width, height: reference.height, status: 'ready', createdAt: now() };
        d.references[r.id] = r; current.status = 'ready'; current.createdReferenceId = r.id;
        if (p.research) for (const item of [asset, ...savedVariants.map(v => v.asset)]) store.job(d, `research-asset:${item}`, { destination: 'research', sessionId: p.sessionId, asset: item });
        if (p.research) store.job(d, `research-reference:${r.id}`, { destination: 'research', sessionId: p.sessionId, asset: `${r.id}.json`, metadata: { ...r, originalAsset: p.asset } });
        return r;
      });
      res.status(201).json(store.publicReference(result));
    } catch (e) { for (const f of files) fs.rmSync(store.assetPath(f), { force: true }); throw e; }
  }));
  router.get('/admin/references/:referenceId/:kind', wrap((req, res) => {
    const r = store.data.references[req.params.referenceId];
    check(r?.id === req.params.referenceId && r.status !== 'deleted', '参照写真が見つかりません', 404);
    const asset = req.params.kind === 'reference' ? r.asset : r.variants.find(v => v.kind === req.params.kind)?.asset;
    check(asset, '画像がありません', 404); res.sendFile(store.assetPath(asset));
  }));
  router.patch('/admin/references/:referenceId', wrap((req, res) => {
    store.transaction(d => {
      const r = d.references[req.params.referenceId];
      check(r?.id === req.params.referenceId && r.status !== 'deleted', '参照写真がありません', 404);
      check(['published', 'ready', 'deleted'].includes(req.body.status), '無効な公開状態');
      const p = d.photos[r.sourcePhotoId];
      if (req.body.status === 'published') {
        check(p?.status === 'ready' || p?.status === 'published', '写真を公開準備完了にしてください', 409);
        check(p?.publication && p.decision === 'saved' && KINDS.every(k => r.variants.some(v => v.kind === k)), '公開条件を満たしていません', 409);
        if (r.status !== 'published') store.event(d, 'frame_published', { referenceId: r.id, sessionId: p.sessionId, photoId: p.id, origin: r.origin });
      } else {
        for (const s of Object.values(d.sessions)) {
          if (r.variants.some(v => v.id === s.activeFrameId)) { s.activeFrameId = null; s.mode = 'free'; s.version++; }
          s.proposals = s.proposals.filter(p => p.referenceId !== r.id);
        }
      }
      r.status = req.body.status;
      if (p) p.status = r.status === 'deleted' ? 'rejected' : r.status;
    }); broadcastAll(); res.json({ ok: true });
  }));
  router.post('/admin/retry', wrap((req, res) => { retryJobs(() => true); res.json({ ok: true }); }));
  router.post('/admin/jobs/:jobId/resolve', wrap((req, res) => {
    store.transaction(d => {
      const j = d.jobs[req.params.jobId]; check(j?.status === 'uncertain', '配送状況の確認対象ではありません', 409);
      check(['delivered', 'retry'].includes(req.body.resolution), '配送済みまたは再送を選んでください');
      Object.assign(j, { status: req.body.resolution === 'delivered' ? 'succeeded' : 'pending', attempts: 0, nextAttemptAt: 0 });
    }); res.json({ ok: true });
  }));
  function analytics() {
    const rows = [];
    for (const r of Object.values(store.data.references)) for (const v of r.variants) {
      const ev = store.data.events.filter(e => e.frameVariantId === v.id);
      rows.push({ referenceId: r.id, name: r.name, origin: r.origin, frameVariantId: v.id, kind: v.kind,
        viewed: ev.filter(e => e.eventType === 'frame_viewed').length, proposed: ev.filter(e => e.eventType === 'frame_proposed').length,
        activated: ev.filter(e => e.eventType === 'frame_activated').length, captured: ev.filter(e => e.eventType === 'photo_captured').length });
    }
    const totals = key => [...new Set(rows.map(r => r[key]))].map(value => ({ [key]: value, ...['viewed', 'proposed', 'activated', 'captured'].reduce((out, metric) => ({ ...out, [metric]: rows.filter(r => r[key] === value).reduce((n, r) => n + r[metric], 0) }), {}) }));
    return { frames: rows, byKind: totals('kind'), byOrigin: totals('origin'),
      sessions: Object.values(store.data.sessions).filter(s => !s.internalLibrary).map(s => ({ sessionId: s.id, subjectCount: s.subjects.length })), recent: store.data.events.slice(-50).reverse() };
  }
  router.get('/admin/analytics', wrap((req, res) => res.json(analytics())));
  router.get('/admin/export.csv', wrap((req, res) => {
    const rows = req.query.type === 'events' ? store.data.events : req.query.type === 'sessions' ? analytics().sessions : analytics().frames;
    const columns = [...new Set(rows.flatMap(Object.keys))];
    const cell = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
    res.type('text/csv').attachment('wiss.csv').send('\uFEFF' + [columns.map(cell).join(','), ...rows.map(r => columns.map(k => cell(r[k])).join(','))].join('\r\n'));
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)).json({ error: error.message });
  });

  function upgrade(req, socket, head) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const s = store.session(store.data, sessionId), actor = store.actor(s, url.searchParams.get('token'));
      check(!s.closed, 'Session closed', 403);
      wss.handleUpgrade(req, socket, head, ws => {
        // A credential represents one device connection; reconnect replaces stale socket.
        for (const [old, c] of clients) if (c.sessionId === sessionId && c.actor.id === actor.id) { clients.delete(old); old.close(4000, 'Reconnected'); }
        clients.set(ws, { sessionId, actor });
        ws.alive = true;
        ws.on('pong', () => { ws.alive = true; });
        ws.on('message', (bytes, binary) => {
          if (store.data.sessions[sessionId].closed) return ws.close(1000, 'Session ended');
          if (!binary || actor.role !== 'photographer' || bytes.length > 1024 * 1024) return;
          for (const [target, c] of clients) if (c.sessionId === sessionId && c.actor.role === 'subject' && target.readyState === WebSocket.OPEN && target.bufferedAmount < 512 * 1024) target.send(bytes, { binary: true });
        });
        ws.on('error', () => {});
        ws.on('close', () => { clients.delete(ws); broadcast(sessionId); });
        broadcast(sessionId);
      });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  }
  const timer = options.noWorker ? null : setInterval(() => integrations.tick().catch(e => console.error('WISS worker:', e.message)), 5000);
  timer?.unref();
  const maintenance = options.noWorker ? null : setInterval(() => {
    try { store.cleanup(Number(env.WISS_DRAFT_TTL_MS || 3600000), false); } catch (e) { console.error('WISS cleanup:', e.message); }
    for (const ws of clients.keys()) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 30000);
  maintenance?.unref();
  return { router, upgrade, store, integrations, broadcast, close() { clearInterval(timer); clearInterval(maintenance); for (const ws of clients.keys()) ws.terminate(); wss.close(); } };
}
module.exports = { createWiss };
