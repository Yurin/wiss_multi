const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');

const id = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const now = () => new Date().toISOString();
function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { statusCode: status });
}

// All mutations are synchronous transactions in one Node process. The renamed
// snapshot includes events and jobs, so neither can be lost between commits.
class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'state.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) :
      { schemaVersion: 1, sessions: {}, photos: {}, references: {}, events: [], jobs: {}, notifications: {} };
    check(this.data.schemaVersion === 1, 'Unsupported WISS schema', 500);
  }
  transaction(fn) {
    const next = structuredClone(this.data);
    const result = fn(next);
    const temporary = `${this.file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    this.data = next;
    return result;
  }
  event(d, eventType, fields = {}) {
    d.events.push({ eventId: id(), timestamp: now(), eventType, ...fields });
  }
  session(d, sessionId) {
    const s = Object.hasOwn(d.sessions, sessionId) ? d.sessions[sessionId] : null;
    check(s, 'セッションが見つかりません', 404);
    return s;
  }
  actor(s, credential) {
    const h = hash(credential);
    if (s.photographerTokenHash === h) return { role: 'photographer', id: 'photographer' };
    const subject = s.subjects.find(p => p.tokenHash === h);
    check(subject, '参加資格が無効です', 401);
    return { role: 'subject', id: subject.id };
  }
  version(s, version) { check(Number.isInteger(version) && version === s.version, '状態が更新されました。再取得して操作してください', 409); }
  frame(d, frameId) {
    const ref = Object.values(d.references).find(r => r.status === 'published' && r.variants.some(v => v.id === frameId));
    check(ref, '公開中のフレームを選んでください', 404);
    return { ref, variant: ref.variants.find(v => v.id === frameId) };
  }
  createSession() {
    const credential = token();
    return this.transaction(d => {
      const s = { id: id(), joinCode: randomBytes(6).toString('hex').toUpperCase(), photographerTokenHash: hash(credential),
        shareToken: token(), createdAt: now(), subjects: [], representativeId: null,
        activeFrameId: null, mode: 'free', version: 0, proposals: [] };
      d.sessions[s.id] = s;
      this.event(d, 'session_created', { sessionId: s.id, subjectCount: 0 });
      return { sessionId: s.id, token: credential };
    });
  }
  join(joinCode) {
    const credential = token();
    return this.transaction(d => {
      const s = Object.values(d.sessions).find(s => s.joinCode === String(joinCode).trim().toUpperCase());
      check(s, '参加コードが見つかりません', 404);
      check(!s.closed, 'セッションは終了しています', 409);
      check(s.subjects.length < 6, '被写体は最大6人です', 409);
      const subject = { id: id(), tokenHash: hash(credential), joinedAt: now(), consent: { research: false, publication: false, answered: false } };
      s.subjects.push(subject);
      s.representativeId ||= subject.id;
      s.version++;
      this.event(d, 'subject_joined', { sessionId: s.id, subjectId: subject.id, subjectCount: s.subjects.length });
      return { sessionId: s.id, subjectId: subject.id, token: credential };
    });
  }
  publicSession(s) {
    const reference = s.activeFrameId ? this.frame(this.data, s.activeFrameId).ref : null;
    return { id: s.id, joinCode: s.joinCode, subjects: s.subjects.map(({ tokenHash, ...p }) => p),
      representativeId: s.representativeId, activeFrameId: s.activeFrameId, mode: s.mode,
      version: s.version, proposals: s.proposals, closed: !!s.closed,
      reference: reference ? this.publicReference(reference) : null };
  }
  publicReference(r) {
    return { id: r.id, name: r.name, subjectCount: r.subjectCount, origin: r.origin, status: r.status,
      imageURL: `/api/wiss/library/${r.id}/reference`, variants: r.variants.map(v => ({ id: v.id, kind: v.kind, imageURL: `/api/wiss/library/${r.id}/${v.kind}` })) };
  }
  mutate(sessionId, credential, action, body) {
    return this.transaction(d => {
      const s = this.session(d, sessionId), actor = this.actor(s, credential);
      check(!s.closed, 'セッションは終了しています', 409);
      const subject = s.subjects.find(p => p.id === actor.id);
      const fields = { sessionId, subjectId: subject?.id, subjectCount: s.subjects.length };
      if (action === 'consent') {
        check(subject, '被写体本人が回答してください', 403);
        check(typeof body.research === 'boolean' && typeof body.publication === 'boolean', '独立した2つの同意を指定してください');
        subject.consent = { research: body.research, publication: body.publication, answered: true, updatedAt: now() };
        this.event(d, 'consent_updated', fields);
      } else if (action === 'representative') {
        check(actor.role === 'photographer' || actor.id === s.representativeId, '代表者または撮影者のみ変更できます', 403);
        this.version(s, body.expectedVersion);
        check(s.subjects.some(p => p.id === body.subjectId), '参加中の被写体を選んでください');
        s.representativeId = body.subjectId;
      } else if (action === 'active-frame') {
        this.version(s, body.expectedVersion);
        check(actor.id === s.representativeId || (actor.role === 'photographer' && body.frameId === null), '代表者のみフレームを確定できます', 403);
        if (body.frameId !== null) {
          const { ref, variant } = this.frame(d, body.frameId);
          this.event(d, 'frame_activated', { ...fields, referenceId: ref.id, frameVariantId: variant.id, kind: variant.kind, origin: ref.origin });
        } else this.event(d, 'free_mode_selected', fields);
        s.activeFrameId = body.frameId;
        s.mode = body.frameId === null ? 'free' : 'frame';
      } else if (action === 'proposals' || action === 'view') {
        check(subject, '被写体の操作です', 403);
        const { ref, variant } = this.frame(d, body.frameId);
        this.event(d, action === 'view' ? 'frame_viewed' : 'frame_proposed', { ...fields, referenceId: ref.id, frameVariantId: variant.id, kind: variant.kind, origin: ref.origin });
        if (action === 'proposals') {
          s.proposals = s.proposals.filter(p => p.subjectId !== actor.id);
          s.proposals.push({ subjectId: actor.id, frameId: variant.id, referenceId: ref.id, name: ref.name, kind: variant.kind, at: now() });
        }
      } else if (action === 'close') {
        check(actor.role === 'photographer', '撮影者専用です', 403);
        s.closed = true;
      } else check(false, 'Unknown action');
      if (action !== 'view') s.version++;
      return s.id;
    });
  }
  job(d, key, payload) {
    d.jobs[key] ||= { id: key, ...payload, status: 'pending', attempts: 0, nextAttemptAt: 0 };
  }
  capture(sessionId, credential, body, asset) {
    return this.transaction(d => {
      const s = this.session(d, sessionId);
      check(this.actor(s, credential).role === 'photographer', '撮影者専用です', 403);
      check(!s.closed, 'セッションは終了しています', 409);
      this.version(s, body.expectedVersion);
      check(s.subjects.length > 0 && s.subjects.every(p => p.consent.answered), '全被写体の同意回答を確認してください', 409);
      check(typeof body.captureId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(body.captureId), 'captureIdが必要です');
      const existing = Object.values(d.photos).find(p => p.sessionId === sessionId && p.captureId === body.captureId);
      if (existing) return existing;
      const selected = s.activeFrameId ? this.frame(d, s.activeFrameId) : null;
      const p = { id: id(), captureId: body.captureId, sessionId, capturedAt: now(), subjectCount: s.subjects.length,
        consents: s.subjects.map(s => ({ subjectId: s.id, ...s.consent })),
        research: s.subjects.every(s => s.consent.research), publication: s.subjects.every(s => s.consent.publication),
        mode: s.mode, referenceId: selected?.ref.id || null, frameVariantId: s.activeFrameId,
        kind: selected?.variant.kind || null, origin: selected?.ref.origin || null,
        asset, decision: 'draft', status: 'pending' };
      d.photos[p.id] = p;
      this.event(d, 'photo_captured', { sessionId, photoId: p.id, subjectCount: p.subjectCount, referenceId: p.referenceId, frameVariantId: p.frameVariantId, kind: p.kind, origin: p.origin });
      return p;
    });
  }
  decide(sessionId, credential, photoId, decision) {
    return this.transaction(d => {
      const s = this.session(d, sessionId);
      check(this.actor(s, credential).role === 'photographer', '撮影者専用です', 403);
      const p = d.photos[photoId];
      check(p && p.sessionId === sessionId, '写真が見つかりません', 404);
      check(['saved', 'deleted'].includes(decision), '保存または削除を選んでください');
      if (p.decision === decision) return p;
      check(p.decision === 'draft', '写真は処理済みです', 409);
      p.decision = decision;
      this.event(d, decision === 'saved' ? 'photo_saved' : 'photo_deleted', { sessionId, photoId, subjectCount: p.subjectCount });
      if (decision === 'saved') {
        this.job(d, `shared:${p.id}`, { destination: 'shared', photoId, sessionId, asset: p.asset });
        if (p.research) this.job(d, `research:${p.id}`, { destination: 'research', photoId, sessionId, asset: p.asset });
        if (p.mode === 'free' && p.publication) {
          d.notifications[p.id] = { photoId, sessionId, capturedAt: p.capturedAt, subjectCount: p.subjectCount, createdAt: now() };
          this.job(d, `mail:${p.id}`, { destination: 'mail', photoId, sessionId });
          this.event(d, 'frame_creation_requested', { sessionId, photoId, subjectCount: p.subjectCount });
        }
      }
      return p;
    });
  }
  assetPath(name) {
    check(typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..'), 'Invalid asset');
    return path.join(this.root, 'assets', name);
  }
  cleanup(ttl = 3600000, purgeOrphans = true) {
    this.transaction(d => {
      for (const p of Object.values(d.photos)) {
        if (p.decision === 'draft' && Date.now() - Date.parse(p.capturedAt) > ttl) {
          p.decision = 'deleted';
          this.event(d, 'photo_deleted', { sessionId: p.sessionId, photoId: p.id, reason: 'draft_expired' });
        }
      }
    });
    const retained = new Set(Object.values(this.data.photos).filter(p => p.decision !== 'deleted').map(p => p.asset));
    for (const r of Object.values(this.data.references)) {
      if (r.status !== 'deleted') { retained.add(r.asset); for (const v of r.variants) retained.add(v.asset); }
    }
    for (const j of Object.values(this.data.jobs)) if (j.asset && !j.metadata) retained.add(j.asset);
    const deleted = new Set(Object.values(this.data.photos).filter(p => p.decision === 'deleted').map(p => p.asset));
    for (const file of fs.readdirSync(path.join(this.root, 'assets'))) {
      if (deleted.has(file) || (purgeOrphans && !retained.has(file))) fs.rmSync(this.assetPath(file), { force: true });
    }
  }
}
module.exports = { Store, check, id, token, hash, now };
